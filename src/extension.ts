import * as vscode from 'vscode';
import { RunQLExtensionApi } from './types';
import { bigqueryProvider } from './provider';
import { BigQueryAdapter } from './bigqueryAdapter';

export async function activate(context: vscode.ExtensionContext) {
  const core = vscode.extensions.getExtension<RunQLExtensionApi>('RunQL-VSCode-Extension.runql');
  if (!core) {
    vscode.window.showWarningMessage('RunQL BigQuery Connector requires RunQL-VSCode-Extension.runql.');
    return;
  }

  const api = await core.activate();
  if (!api || typeof api.registerProvider !== 'function' || typeof api.registerAdapter !== 'function') {
    vscode.window.showWarningMessage('RunQL core API is unavailable. Update RunQL and try again.');
    return;
  }

  context.subscriptions.push(
    api.registerProvider(bigqueryProvider),
    api.registerAdapter('bigquery', () => new BigQueryAdapter())
  );
}

export function deactivate() {
  // no-op
}
