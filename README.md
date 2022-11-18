
# clickhouse-migrations

> CLI NodeJS ClickHouse Migrations.

## Install

```sh
npm install --global clickhouse-migrations
```

## Usage

Create a directory, where migrations will be stored. It will be used as the value for the `--migrations-home` option.

In the directory, create migrations - which should be named like: `1_`some_text`.sql`, `2_`other_text`.sql`, ... `10_`more_test`.sql`. What is important here: migration versions followed by underscore - `1_`, `2_`, ...`10_`..., and file extension `.sql`. Any text can follow by version number. The version number should increase for every next migration.

For migrations' content should be used correct SQL ClickHouse queries. A few queries can be used in one migration file. Every query should end with `;`. The queries could be idempotent - for example: `CREATE TABLE IF NOT EXISTS table ...;` For adding comments should be used `--`, `# `, `#!` at the beginning of the line.

```
  Usage
    $ clickhouse-migrations migrate <options>

  Required options
      --host=<name>             Clickhouse hostname, in 
                                  format https://clichouse
      --port=<number>           Port
      --user=<name>             Username
      --pass=<password>         Password
      --db-name=<database>      Database name
      --migrations-home=<dir>   Migrations' directory

  Examples
      clickhouse-migrations migrate --host=http://localhost 
      --port=8123 --user=default --pass='' 
      --db-name=analytics --migrations-home=/app/clickhouse/migrations

```