const { TableClient } = require('@azure/data-tables');

// Implementa la interfaz PersistenceAdapter de ask-sdk-core sobre Azure Table Storage,
// ya que ask-sdk no incluye un adapter oficial para Azure (a diferencia de DynamoDB en AWS).
class AzureTablePersistenceAdapter {
  constructor({ connectionString, tableName }) {
    this.tableClient = TableClient.fromConnectionString(connectionString, tableName, {
      allowInsecureConnection: connectionString.includes('UseDevelopmentStorage=true')
    });
    this._ready = this.tableClient.createTable().catch((err) => {
      if (err.statusCode !== 409) throw err; // 409 = la tabla ya existe
    });
  }

  static getUserId(requestEnvelope) {
    return requestEnvelope.context.System.user.userId;
  }

  async getAttributes(requestEnvelope) {
    await this._ready;
    const userId = AzureTablePersistenceAdapter.getUserId(requestEnvelope);
    try {
      const entity = await this.tableClient.getEntity(userId, userId);
      return JSON.parse(entity.attributes);
    } catch (err) {
      if (err.statusCode === 404) return {};
      throw err;
    }
  }

  async saveAttributes(requestEnvelope, attributes) {
    await this._ready;
    const userId = AzureTablePersistenceAdapter.getUserId(requestEnvelope);
    await this.tableClient.upsertEntity(
      { partitionKey: userId, rowKey: userId, attributes: JSON.stringify(attributes) },
      'Replace'
    );
  }

  async deleteAttributes(requestEnvelope) {
    await this._ready;
    const userId = AzureTablePersistenceAdapter.getUserId(requestEnvelope);
    await this.tableClient.deleteEntity(userId, userId);
  }
}

module.exports = { AzureTablePersistenceAdapter };
