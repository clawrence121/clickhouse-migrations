import { setDefaultResultOrder } from "dns";

const { createClient } = require('@clickhouse/client');
const { Command } = require('commander');
const fs = require('fs');
const crypto = require('crypto');

// Extract SQL queries from migrations.
const sql_queries = (content: string): string[] => {
  const queries = content
    .replace(/^(--|#!|# ).*(\n|\r\n|\r)$/gm, '')
    .replace(/(\n|\r\n|\r)/gm, ' ')
    .replace(/\s+/g, ' ')
    .split(';')
    .map((el: string) => el.trim())
    .filter((el: string) => el.length != 0);

  return queries;
};

const log = (type: 'info' | 'error' = 'info', message: string, error?: string) => {
  if (type === 'info') {
    console.log('\x1b[36m', `clickhouse-migrations :`, '\x1b[0m', message);
  } else {
    console.error('\x1b[36m', `clickhouse-migrations :`, '\x1b[31m', `Error: ${message}`, error ? `\n\n ${error}` : '');
  }
};

const connect = (host: string, port: string, username: string, password: string, db_name?: string): any => {
  const db_params: ClickhouseDbParams = {
    url: host,
    port: parseInt(port),
    debug: false,
    basicAuth: {
      username: username,
      password: password,
    },
    isUseGzip: false,
    format: 'json',
    raw: false,
    config: {
      session_timeout: 60,
      output_format_json_quote_64bit_integers: 0,
      enable_http_compression: 0,
    },
  };

  if (db_name) {
    db_params.database = db_name;
  }

  return new createClient(db_params);
};

const create_db = async (
  host: string,
  port: string,
  username: string,
  password: string,
  db_name: string,
): Promise<void> => {
  const client = connect(host, port, username, password);

  // TODO: provided engine type over parameters
  const q: string = `CREATE DATABASE IF NOT EXISTS ${db_name} ENGINE = Atomic`;

  try {
    await client.exec({
      query: q,
    });
  } catch (e: any) {
    log('error', `can't create the database ${db_name}.`, e.message);
    process.exit(1);
  }

  await client.close();
};

const init_migration_table = async (client: any): Promise<void> => {
  const q: string = `CREATE TABLE IF NOT EXISTS _migrations (
      uid UUID DEFAULT generateUUIDv4(), 
      version UInt32,
      checksum String, 
      migration_name String, 
      applied_at DateTime DEFAULT now()
    ) 
    ENGINE = MergeTree 
    ORDER BY tuple(applied_at)`;

  try {
    await client.exec({
      query: q,
    });
  } catch (e: any) {
    log('error', `can't create the _migrations table.`, e.message);
    process.exit(1);
  }
};

const get_migrations = (migrations_home: string): { version: number; file: string }[] => {
  let files;
  try {
    files = fs.readdirSync(migrations_home);
  } catch (e) {
    log('error', `no migration directory ${migrations_home}. Please create it.`);
    process.exit(1);
  }

  const migrations: MigrationBase[] = [];
  files.forEach((file: string) => {
    const version = Number(file.split('_')[0]);

    // Manage only .sql files.
    if (!file.endsWith('.sql')) return;

    migrations.push({
      version,
      file,
    });
  });

  if (!migrations) {
    log('error', `no migrations in the ${migrations_home} migrations directory`);
  }

  // Order by version.
  migrations.sort((m1, m2) => m1.version - m2.version);

  return migrations;
};

const apply_migrations = async (client: any, migrations: MigrationBase[], migrations_home: string): Promise<void> => {
  let migration_query_result: string[] = [];
  try {
    const resultSet = await client.query({
      query: `SELECT version, checksum, migration_name FROM _migrations ORDER BY version`,
      format: 'JSONEachRow',
    });
    migration_query_result = await resultSet.json();
  } catch (e: any) {
    log('error', `can't select data from the _migrations table.`, e.message);
    process.exit(1);
  }

  let migrations_applied: any = {};
  migration_query_result.forEach((row: any) => {
    migrations_applied[row.version] = {
      checksum: row.checksum,
      migration_name: row.migration_name,
    };

    // Check if migration file was not removed after apply.
    const migration_exist = migrations.find(({ version }) => version === row.version);
    if (!migration_exist) {
      log(
        'error',
        `a migration file shouldn't be removed after apply. Please, restore the migration ${row.migration_name}.`,
      );
      process.exit(1);
    }
  });

  let applied_migrations = '';

  for (const migration of migrations) {
    const content = fs.readFileSync(migrations_home + '/' + migration.file).toString();
    const checksum = crypto.createHash('md5').update(content).digest('hex');

    if (migrations_applied[migration.version]) {
      // Check if migration file was not changed after apply.
      if (migrations_applied[migration.version].checksum !== checksum) {
        log(
          'error',
          `a migration file should't be changed after apply. Please, restore content of the ${
            migrations_applied[migration.version].migration_name
          } migrations.`,
        );
        process.exit(1);
      }

      // Skip if a migration is already applied.
      continue;
    }

    // Extract sql from the migration.
    var queries = sql_queries(content);

    for (const query of queries) {
      try {
        await client.exec({
          query: query,
        });
      } catch (e: any) {
        if (applied_migrations) {
          log('info', `The migration(s) ${applied_migrations} was successfully applied!`);
        }

        log(
          'error',
          `the migrations ${migration.file} has an error. Please, fix it (be sure that already executed parts of the migration would not be run second time) and re-run migration script.`,
          e.message,
        );
        process.exit(1);
      }
    }

    try {
      await client.insert({
        table: '_migrations',
        values: [{ version: migration.version, checksum: checksum, migration_name: migration.file }],
        format: 'JSONEachRow',
      });
    } catch (e: any) {
      log('error', `can't insert a data into the table _migrations.`, e.message);
      process.exit(1);
    }

    applied_migrations = applied_migrations ? applied_migrations + ', ' + migration.file : migration.file;
  }

  if (applied_migrations) {
    log('info', `The migration(s) ${applied_migrations} was successfully applied!`);
  } else {
    log('info', `No migrations to apply.`);
  }
};

const migration = async (
  migrations_home: string,
  host: string,
  port: string,
  username: string,
  password: string,
  db_name: string,
): Promise<void> => {
  const migrations = get_migrations(migrations_home);

  await create_db(host, port, username, password, db_name);

  const client = connect(host, port, username, password, db_name);

  await init_migration_table(client);

  await apply_migrations(client, migrations, migrations_home);

  await client.close();
};

export const migrate = () => {
  const program = new Command();

  program.name('clickhouse-migrations').description('ClickHouse migrations.').version('1.0.0');

  program
    .command('migrate')
    .description('apply migrations.')
    .requiredOption('--host <name>', 'clickhouse hostname in format http://clickhouse')
    .requiredOption('--port <number>', 'port')
    .requiredOption('--user <name>', 'username')
    .requiredOption('--pass <password>', 'password')
    .requiredOption('--db-name <dbname>', 'database name')
    .requiredOption('--migrations-home <dir>', 'migrations directory')
    .action(async (options: CliParameters) => {
      await migration(options.migrationsHome, options.host, options.port, options.user, options.pass, options.dbName);
    });

  program.parse();
};