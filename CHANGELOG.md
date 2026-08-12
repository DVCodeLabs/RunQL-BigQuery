# Changelog

All notable changes to the RunQL BigQuery Connector will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - First Release

### Added
- Initial release.
- BigQuery connection provider.
- `BigQueryAdapter` with query execution, non-query execution, and schema introspection for datasets, tables, views, columns, constraints, routines, and routine parameters where metadata permissions allow.


## [1.0.1]

### Changed
- Update extension icon.

## [1.1.0]

### Changed
- Changed how the introspection of schemas works.

## [1.2.0]

### Changes

#### More Table Actions in RunQL Explorer

Right-click any table in RunQL Explorer to:

- Copy the table name
- Edit the table
- View table DDL
- Generate SELECT, INSERT, UPDATE, and DELETE templates
- Dump table structure
- Generate mock data
- Copy, drop, or truncate a table