# RunQL BigQuery Connector

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![VS Code](https://img.shields.io/badge/vscode-%5E1.96.0-007ACC)](https://code.visualstudio.com/)

Optional BigQuery connector for the [RunQL](https://marketplace.visualstudio.com/items?itemName=RunQL-VSCode-Extension.runql) VS Code extension. Install alongside RunQL to query BigQuery projects with RunQL's SQL workflows, results panel, schema introspection, and ERD tooling.

This extension is maintained separately so users who do not need BigQuery are not required to install Google Cloud driver dependencies.

## Installation

1. Install [RunQL](https://marketplace.visualstudio.com/items?itemName=RunQL-VSCode-Extension.runql) (required, declared as an extension dependency).
2. Install **RunQL BigQuery Connector** from the VS Code Marketplace.

RunQL will detect the connector on activation and register BigQuery as an available connection provider.

## Usage

1. Open the RunQL explorer view.
2. Click **Add Connection** and choose **BigQuery**.
3. Enter the Google Cloud project ID.
4. Optionally enter a default dataset and query job location.
5. Choose Application Default Credentials, a service-account key file, or pasted service-account JSON.
6. Save and test the connection.

## Requirements

- VS Code `^1.96.0`
- [RunQL](https://marketplace.visualstudio.com/items?itemName=RunQL-VSCode-Extension.runql) extension
- A Google Cloud project with BigQuery enabled
- Credentials with permissions to run jobs and read the datasets you want to inspect

## Authentication

The connector supports:

- Application Default Credentials
- Service-account key file authentication
- Pasted service-account JSON stored in VS Code secret storage

## How it works

On activation, this extension acquires the RunQL extension API and calls:

- `registerProvider(bigqueryProvider)` to add BigQuery to the connection form.
- `registerAdapter('bigquery', () => new BigQueryAdapter())` to wire the dialect to its implementation.

The adapter uses the [`@google-cloud/bigquery`](https://www.npmjs.com/package/@google-cloud/bigquery) Node package. Schema introspection enumerates visible datasets through the BigQuery API, reads table metadata for columns and constraints, and uses dataset-level `INFORMATION_SCHEMA` queries for routines where permissions allow.

## Building from source

```bash
git clone https://github.com/DVCodeLabs/RunQL-BigQuery.git
cd RunQL-BigQuery
npm install
npm run package
```

To produce a local VSIX for testing:

```bash
npm install -g @vscode/vsce
vsce package
```

## License

MIT, see [LICENSE](./LICENSE).
