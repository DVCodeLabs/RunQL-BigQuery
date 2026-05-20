import { DPProviderDescriptor } from './types';

export const bigqueryProvider: DPProviderDescriptor = {
  providerId: 'bigquery',
  displayName: 'BigQuery',
  dialect: 'bigquery',
  formSchema: {
    fields: [
      {
        key: 'projectId',
        label: 'Project ID',
        type: 'text',
        tab: 'connection',
        storage: 'profile',
        required: true,
        placeholder: 'my-gcp-project',
        width: 'half'
      },
      {
        key: 'location',
        label: 'Location (Optional)',
        type: 'text',
        tab: 'connection',
        storage: 'profile',
        placeholder: 'US',
        description: 'Used for query jobs. Leave blank to let BigQuery choose the default location.',
        width: 'half'
      },
      {
        key: 'schema',
        label: 'Default Dataset (Optional)',
        type: 'text',
        tab: 'connection',
        storage: 'profile',
        placeholder: 'analytics',
        description: 'Used as the default dataset for unqualified table references. Introspection returns all visible datasets in the project.',
        width: 'full'
      },
      {
        key: 'authMode',
        label: 'Authentication Mode',
        type: 'select',
        tab: 'auth',
        storage: 'profile',
        defaultValue: 'adc',
        options: [
          { value: 'adc', label: 'Application Default Credentials' },
          { value: 'serviceAccountKeyFile', label: 'Service Account Key File' },
          { value: 'serviceAccountJson', label: 'Service Account JSON' }
        ],
        width: 'full'
      },
      {
        key: 'privateKeyPath',
        label: 'Service Account Key File',
        type: 'file',
        tab: 'auth',
        storage: 'profile',
        required: true,
        placeholder: '/path/to/service-account.json',
        visibleWhen: {
          storage: 'profile',
          key: 'authMode',
          equals: 'serviceAccountKeyFile'
        },
        picker: {
          mode: 'open',
          title: 'Select Service Account Key',
          openLabel: 'Select Key',
          canSelectFiles: true,
          canSelectFolders: false,
          filters: {
            'JSON Key Files': ['json'],
            'All Files': ['*']
          }
        },
        width: 'full'
      },
      {
        key: 'serviceAccountJson',
        label: 'Service Account JSON',
        type: 'textarea',
        tab: 'auth',
        storage: 'secrets',
        required: true,
        placeholder: '{ "type": "service_account", ... }',
        visibleWhen: {
          storage: 'profile',
          key: 'authMode',
          equals: 'serviceAccountJson'
        },
        width: 'full'
      }
    ]
  },
  supports: {
    ssl: true,
    oauth: false,
    keypair: true,
    introspection: true,
    cancellation: true
  }
};
