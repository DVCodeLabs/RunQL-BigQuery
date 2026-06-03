import { BigQuery } from '@google-cloud/bigquery';
import {
  ColumnModel,
  ConnectionProfile,
  ConnectionSecrets,
  DbAdapter,
  ForeignKeyModel,
  NonQueryResult,
  QueryColumn,
  QueryResult,
  QueryRunOptions,
  RoutineModel,
  RoutineParameterModel,
  SchemaIntrospection,
  SchemaModel,
  TableModel
} from './types';

interface BigQuerySchemaEntry {
  name: string;
  tables: Map<string, TableModel>;
  views: Map<string, TableModel>;
  procedures: RoutineModel[];
  functions: RoutineModel[];
}

interface BigQueryField {
  name?: string;
  type?: string;
  mode?: string;
  description?: string;
  fields?: BigQueryField[];
}

interface BigQueryRoutineRow {
  [key: string]: unknown;
  routine_name?: string;
  routine_type?: string;
  data_type?: string;
  routine_definition?: string;
}

interface BigQueryParameterRow {
  [key: string]: unknown;
  specific_name?: string;
  parameter_name?: string;
  data_type?: string;
  parameter_mode?: string;
  ordinal_position?: number | string;
}

export class BigQueryAdapter implements DbAdapter {
  readonly dialect = 'bigquery';

  async testConnection(profile: ConnectionProfile, secrets: ConnectionSecrets): Promise<void> {
    const client = this.createClient(profile, secrets);
    await this.runQueryJob(client, profile, 'SELECT 1 AS ok');
  }

  async runQuery(
    profile: ConnectionProfile,
    secrets: ConnectionSecrets,
    sql: string,
    options: QueryRunOptions
  ): Promise<QueryResult> {
    const client = this.createClient(profile, secrets);
    const maxRows = Math.max(1, options.maxRows || 10000);
    const start = Date.now();
    const { job, rows, nextPageToken } = await this.runQueryJob(client, profile, sql, maxRows);
    const elapsedMs = Date.now() - start;
    const columns = await this.extractQueryColumns(job, rows);

    return {
      columns,
      rows,
      rowCount: rows.length,
      elapsedMs,
      warning: nextPageToken ? `Result limited to the first ${rows.length} rows.` : undefined
    };
  }

  async executeNonQuery(
    profile: ConnectionProfile,
    secrets: ConnectionSecrets,
    sql: string
  ): Promise<NonQueryResult> {
    const client = this.createClient(profile, secrets);
    const { job } = await this.runQueryJob(client, profile, sql, 1);
    const metadata = await this.getJobMetadata(job);
    const affectedRows = getNestedNumber(metadata, ['statistics', 'query', 'numDmlAffectedRows']);
    return { affectedRows: affectedRows ?? null };
  }

  async introspectSchema(
    profile: ConnectionProfile,
    secrets: ConnectionSecrets
  ): Promise<SchemaIntrospection> {
    const client = this.createClient(profile, secrets);
    const schemasMap = new Map<string, BigQuerySchemaEntry>();

    const requestedDataset = profile.schema?.trim();
    const datasetIds = requestedDataset
      ? [requestedDataset]
      : await this.getVisibleDatasetIds(client);

    for (const datasetId of datasetIds) {
      const schema = this.ensureSchema(schemasMap, datasetId);
      const dataset = (client as any).dataset(datasetId);

      try {
        const [tables] = await dataset.getTables({ autoPaginate: true });
        for (const tableRef of tables as any[]) {
          await this.addTableMetadata(schema, tableRef);
        }
      } catch {
        // Dataset-level permissions can differ from project-level visibility.
      }

      await this.addRoutineMetadata(client, profile, schema, datasetId);
    }

    const schemas: SchemaModel[] = Array.from(schemasMap.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((schema) => ({
        name: schema.name,
        tables: Array.from(schema.tables.values()).sort((a, b) => a.name.localeCompare(b.name)),
        views: Array.from(schema.views.values()).sort((a, b) => a.name.localeCompare(b.name)),
        procedures: schema.procedures.sort((a, b) => a.name.localeCompare(b.name)),
        functions: schema.functions.sort((a, b) => a.name.localeCompare(b.name))
      }));

    return {
      version: '0.2',
      generatedAt: new Date().toISOString(),
      connectionId: profile.id,
      connectionName: profile.name,
      dialect: 'bigquery',
      schemas
    };
  }

  private createClient(profile: ConnectionProfile, secrets: ConnectionSecrets): BigQuery {
    const options: Record<string, unknown> = {};
    const projectId = this.resolveProjectId(profile, secrets);
    if (projectId) {
      options.projectId = projectId;
    }

    if (profile.authMode === 'serviceAccountKeyFile') {
      if (!profile.privateKeyPath) {
        throw new Error('Service account key file is required for BigQuery key-file authentication.');
      }
      options.keyFilename = profile.privateKeyPath;
    } else if (profile.authMode === 'serviceAccountJson') {
      const credentials = this.parseServiceAccountJson(secrets);
      options.credentials = credentials;
      if (!options.projectId && typeof credentials.project_id === 'string') {
        options.projectId = credentials.project_id;
      }
    }

    return new BigQuery(options as any);
  }

  private resolveProjectId(profile: ConnectionProfile, secrets: ConnectionSecrets): string | undefined {
    const profileProject = profile.projectId?.trim();
    if (profileProject) {
      return profileProject;
    }

    if (profile.authMode === 'serviceAccountJson') {
      try {
        const credentials = this.parseServiceAccountJson(secrets);
        if (typeof credentials.project_id === 'string' && credentials.project_id.trim()) {
          return credentials.project_id.trim();
        }
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  private parseServiceAccountJson(secrets: ConnectionSecrets): Record<string, unknown> {
    const raw = String(secrets.serviceAccountJson ?? '').trim();
    if (!raw) {
      throw new Error('Service account JSON is required for BigQuery service-account authentication.');
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error('missing required fields');
      }
      return parsed;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid BigQuery service account JSON: ${detail}`);
    }
  }

  private buildQueryOptions(profile: ConnectionProfile, sqlText: string): Record<string, unknown> {
    const queryOptions: Record<string, unknown> = {
      query: sqlText,
      useLegacySql: false
    };

    const location = this.getLocation(profile);
    if (location) {
      queryOptions.location = location;
    }

    const projectId = profile.projectId?.trim();
    const datasetId = profile.schema?.trim();
    if (projectId && datasetId) {
      queryOptions.defaultDataset = { projectId, datasetId };
    }

    return queryOptions;
  }

  private getLocation(profile: ConnectionProfile): string | undefined {
    return typeof profile.location === 'string' && profile.location.trim() ? profile.location.trim() : undefined;
  }

  private async runQueryJob(
    client: BigQuery,
    profile: ConnectionProfile,
    sqlText: string,
    maxRows?: number
  ): Promise<{ job: unknown; rows: Record<string, unknown>[]; nextPageToken?: string }> {
    const [job] = await (client as any).createQueryJob(this.buildQueryOptions(profile, sqlText));
    const resultOptions: Record<string, unknown> = {};
    if (maxRows !== undefined) {
      resultOptions.maxResults = maxRows;
      resultOptions.autoPaginate = false;
    }

    const result = await (job as any).getQueryResults(resultOptions);
    const rows = ((result[0] ?? []) as unknown[]).map((row) => toJsonSafe(row)) as Record<string, unknown>[];
    const nextQuery = result[1] as { pageToken?: string } | undefined;
    return { job, rows, nextPageToken: nextQuery?.pageToken };
  }

  private async extractQueryColumns(job: unknown, rows: Record<string, unknown>[]): Promise<QueryColumn[]> {
    const metadata = await this.getJobMetadata(job);
    const fields = getNestedArray(metadata, ['statistics', 'query', 'schema', 'fields']);
    if (fields.length > 0) {
      return fields.map((field) => {
        const name = getString(field, 'name') || '';
        const type = getString(field, 'type');
        const mode = getString(field, 'mode');
        return {
          name,
          type: mode && mode !== 'NULLABLE' && type ? `${type} ${mode}` : type,
          normalizedType: type
        };
      });
    }

    const first = rows[0];
    return first ? Object.keys(first).map((name) => ({ name })) : [];
  }

  private async getJobMetadata(job: unknown): Promise<Record<string, unknown>> {
    try {
      const [metadata] = await (job as any).getMetadata();
      return metadata as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async addTableMetadata(schema: BigQuerySchemaEntry, tableRef: any): Promise<void> {
    let metadata: Record<string, unknown>;
    try {
      [metadata] = await tableRef.getMetadata();
    } catch {
      return;
    }

    const tableName = this.getTableId(tableRef, metadata);
    if (!tableName) {
      return;
    }

    const table: TableModel = {
      name: tableName,
      comment: getString(metadata, 'description'),
      columns: this.mapColumns(getNestedArray(metadata, ['schema', 'fields'])),
      foreignKeys: []
    };

    const primaryKeyColumns = getNestedStringArray(metadata, ['tableConstraints', 'primaryKey', 'columns']);
    if (primaryKeyColumns.length > 0) {
      table.primaryKey = primaryKeyColumns;
    }

    const foreignKeys = this.mapForeignKeys(metadata);
    if (foreignKeys.length > 0) {
      table.foreignKeys = foreignKeys;
    }

    const tableType = getString(metadata, 'type')?.toUpperCase() ?? '';
    if (tableType === 'VIEW' || tableType === 'MATERIALIZED_VIEW') {
      schema.views.set(tableName, table);
    } else {
      schema.tables.set(tableName, table);
    }
  }

  private mapColumns(fields: Record<string, unknown>[]): ColumnModel[] {
    return fields.map((field) => {
      const name = getString(field, 'name') || '';
      const type = this.formatFieldType(field as BigQueryField);
      const mode = getString(field, 'mode')?.toUpperCase();
      return {
        name,
        type,
        nullable: mode !== 'REQUIRED',
        comment: getString(field, 'description')
      };
    });
  }

  private formatFieldType(field: BigQueryField): string {
    const type = (field.type || 'UNKNOWN').toUpperCase();
    const fields = field.fields ?? [];
    if (type === 'RECORD' || type === 'STRUCT') {
      const children = fields
        .map((child) => `${child.name || 'field'} ${this.formatFieldType(child)}`)
        .join(', ');
      return `STRUCT<${children}>`;
    }

    if ((field.mode || '').toUpperCase() === 'REPEATED') {
      return `ARRAY<${type}>`;
    }

    return type;
  }

  private mapForeignKeys(metadata: Record<string, unknown>): ForeignKeyModel[] {
    const rawForeignKeys = getNestedArray(metadata, ['tableConstraints', 'foreignKeys']);
    const foreignKeys: ForeignKeyModel[] = [];

    for (const rawForeignKey of rawForeignKeys) {
      const name = getString(rawForeignKey, 'name');
      const referencedTable = getRecord(rawForeignKey, 'referencedTable');
      const foreignSchema = getString(referencedTable, 'datasetId');
      const foreignTable = getString(referencedTable, 'tableId');
      const columnReferences = getArray(rawForeignKey, 'columnReferences');

      if (!foreignSchema || !foreignTable) {
        continue;
      }

      for (const columnReference of columnReferences) {
        const column = getString(columnReference, 'referencingColumn');
        const foreignColumn = getString(columnReference, 'referencedColumn');
        if (!column || !foreignColumn) {
          continue;
        }

        foreignKeys.push({
          name,
          column,
          foreignSchema,
          foreignTable,
          foreignColumn
        });
      }
    }

    return foreignKeys;
  }

  private async addRoutineMetadata(
    client: BigQuery,
    profile: ConnectionProfile,
    schema: BigQuerySchemaEntry,
    datasetId: string
  ): Promise<void> {
    const routineRows = await this.queryDatasetInformationSchema<BigQueryRoutineRow>(
      client,
      profile,
      datasetId,
      `
        SELECT
          routine_name,
          routine_type,
          data_type,
          routine_definition
        FROM ${this.quoteDataset(datasetId)}.INFORMATION_SCHEMA.ROUTINES
        ORDER BY routine_name
      `
    );

    if (routineRows.length === 0) {
      return;
    }

    const parameterRows = await this.queryDatasetInformationSchema<BigQueryParameterRow>(
      client,
      profile,
      datasetId,
      `
        SELECT
          specific_name,
          parameter_name,
          data_type,
          parameter_mode,
          ordinal_position
        FROM ${this.quoteDataset(datasetId)}.INFORMATION_SCHEMA.PARAMETERS
        ORDER BY specific_name, ordinal_position
      `
    );

    const parametersByRoutine = new Map<string, RoutineParameterModel[]>();
    for (const row of parameterRows) {
      const routineName = row.specific_name;
      if (!routineName) {
        continue;
      }

      const position = parseNumber(row.ordinal_position);
      const parameter: RoutineParameterModel = {
        name: row.parameter_name || (position ? `arg${position}` : 'arg'),
        mode: this.normalizeParameterMode(row.parameter_mode),
        type: row.data_type || undefined,
        position
      };

      const existing = parametersByRoutine.get(routineName) ?? [];
      existing.push(parameter);
      parametersByRoutine.set(routineName, existing);
    }

    for (const row of routineRows) {
      const routineName = row.routine_name;
      if (!routineName) {
        continue;
      }

      const kind = row.routine_type === 'PROCEDURE' ? 'procedure' : 'function';
      const routine: RoutineModel = {
        name: routineName,
        kind,
        returnType: row.data_type || undefined,
        language: this.inferRoutineLanguage(row.routine_definition),
        schemaQualifiedName: `${datasetId}.${routineName}`,
        parameters: (parametersByRoutine.get(routineName) ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      };
      routine.signature = this.buildRoutineSignature(routine);

      if (kind === 'procedure') {
        schema.procedures.push(routine);
      } else {
        schema.functions.push(routine);
      }
    }
  }

  private async queryDatasetInformationSchema<T extends Record<string, unknown>>(
    client: BigQuery,
    profile: ConnectionProfile,
    datasetId: string,
    sqlText: string
  ): Promise<T[]> {
    try {
      const { rows } = await this.runQueryJob(
        client,
        { ...profile, schema: datasetId },
        sqlText
      );
      return rows.map((row) => normalizeRecordKeys(row)) as T[];
    } catch {
      return [];
    }
  }

  private async getVisibleDatasetIds(client: BigQuery): Promise<string[]> {
    const [datasets] = await (client as any).getDatasets({ autoPaginate: true });
    return (datasets as any[])
      .map((dataset) => this.getDatasetId(dataset))
      .filter((datasetId): datasetId is string => Boolean(datasetId))
      .sort((a, b) => a.localeCompare(b));
  }

  private inferRoutineLanguage(definition: string | undefined): string | undefined {
    if (!definition) {
      return undefined;
    }
    return definition.trim().toUpperCase().startsWith('JS') ? 'JAVASCRIPT' : 'SQL';
  }

  private normalizeParameterMode(modeRaw: string | undefined): 'in' | 'out' | 'inout' | 'variadic' | 'return' | undefined {
    const value = (modeRaw ?? '').trim().toUpperCase();
    if (value === 'IN') return 'in';
    if (value === 'OUT') return 'out';
    if (value === 'INOUT') return 'inout';
    return undefined;
  }

  private buildRoutineSignature(routine: RoutineModel): string {
    const args = (routine.parameters ?? [])
      .map((parameter) => {
        const modePrefix = parameter.mode ? `${parameter.mode.toUpperCase()} ` : '';
        const typeSuffix = parameter.type ? ` ${parameter.type}` : '';
        return `${modePrefix}${parameter.name}${typeSuffix}`.trim();
      })
      .join(', ');
    return `${routine.name}(${args})`;
  }

  private ensureSchema(schemasMap: Map<string, BigQuerySchemaEntry>, name: string): BigQuerySchemaEntry {
    if (!schemasMap.has(name)) {
      schemasMap.set(name, {
        name,
        tables: new Map(),
        views: new Map(),
        procedures: [],
        functions: []
      });
    }
    return schemasMap.get(name)!;
  }

  private getDatasetId(dataset: any): string | undefined {
    return (
      getNestedString(dataset, ['id'])?.split(':').pop() ||
      getNestedString(dataset, ['metadata', 'datasetReference', 'datasetId'])
    );
  }

  private getTableId(tableRef: any, metadata: Record<string, unknown>): string | undefined {
    return (
      getString(metadata, 'id')?.split('.').pop() ||
      getNestedString(metadata, ['tableReference', 'tableId']) ||
      getNestedString(tableRef, ['id'])?.split('.').pop()
    );
  }

  private quoteDataset(datasetId: string): string {
    return `\`${datasetId.replace(/`/g, '')}\``;
  }
}

function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') {
    return value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const constructorName = value.constructor?.name ?? '';
    if (constructorName.startsWith('BigQuery') && typeof record.value === 'string') {
      return record.value;
    }

    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      out[key] = toJsonSafe(nested);
    }
    return out;
  }
  return value;
}

function normalizeRecordKeys(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function getString(row: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = row?.[key];
  if (typeof value === 'string') return value.trim() || undefined;
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function getArray(row: Record<string, unknown> | undefined, key: string): Record<string, unknown>[] {
  const value = row?.[key];
  return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

function getRecord(row: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = row?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function getNestedString(row: Record<string, unknown> | undefined, path: string[]): string | undefined {
  let current: unknown = row;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' && current.trim() ? current.trim() : undefined;
}

function getNestedNumber(row: Record<string, unknown> | undefined, path: string[]): number | undefined {
  let current: unknown = row;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return parseNumber(current);
}

function getNestedArray(row: Record<string, unknown> | undefined, path: string[]): Record<string, unknown>[] {
  let current: unknown = row;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return [];
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return Array.isArray(current) ? current as Record<string, unknown>[] : [];
}

function getNestedStringArray(row: Record<string, unknown> | undefined, path: string[]): string[] {
  return getNestedArray(row, path)
    .map((entry) => String(entry))
    .filter(Boolean);
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
