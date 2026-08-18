const express = require('express');
const { ExpressAdapter } = require('ask-sdk-express-adapter');
const { createHandler } = require('azure-function-express');
const { buildSkillBuilder } = require('../lib/skill');
const { AzureTablePersistenceAdapter } = require('../lib/azureTablePersistenceAdapter');

const persistenceAdapter = new AzureTablePersistenceAdapter({
  connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
  tableName: process.env.AZURE_TABLE_NAME || 'AlexaCaracolState'
});

const skill = buildSkillBuilder(persistenceAdapter).create();

// El endpoint es una URL pública (no un ARN de Lambda), así que Alexa exige verificar
// la firma y el timestamp de cada petición: no desactives estos dos "true".
const adapter = new ExpressAdapter(skill, true, true);

const app = express();
app.post('/api/alexa/skill', adapter.getRequestHandlers());

module.exports = createHandler(app);
