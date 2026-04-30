// Azure resources for the Wendler 5/3/1 PWA.
// Deploys: Static Web App, Cosmos DB (free tier serverless), App Insights, Key Vault.

targetScope = 'resourceGroup'

@description('Short name suffix to keep resource names unique within the RG (lowercase, alphanumeric).')
param namePrefix string = 'wendler'

@description('Azure region for non-SWA resources. SWA region is set separately.')
param location string = resourceGroup().location

@description('Static Web Apps region. Limited set: westus2, centralus, eastus2, westeurope, eastasia.')
@allowed([
  'westus2'
  'centralus'
  'eastus2'
  'westeurope'
  'eastasia'
])
param swaLocation string = 'westeurope'

@description('Static Web Apps SKU.')
@allowed([
  'Free'
  'Standard'
])
param swaSku string = 'Free'

var cosmosName = '${namePrefix}-cosmos-${uniqueString(resourceGroup().id)}'
var swaName = '${namePrefix}-swa'
var appiName = '${namePrefix}-appi'
var lawName = '${namePrefix}-law'
var kvName = take('${namePrefix}-kv-${uniqueString(resourceGroup().id)}', 24)

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: lawName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: appiName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: law.id
  }
}

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: cosmosName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    enableFreeTier: true
    capabilities: [
      { name: 'EnableServerless' }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
  }
}

resource cosmosDb 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmos
  name: 'wendler'
  properties: {
    resource: { id: 'wendler' }
  }
}

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: swaName
  location: swaLocation
  sku: {
    name: swaSku
    tier: swaSku
  }
  properties: {
    provider: 'None'
    buildProperties: {
      appLocation: 'apps/web'
      apiLocation: 'apps/api'
      outputLocation: '.next'
    }
  }
}

resource swaSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    APPLICATIONINSIGHTS_CONNECTION_STRING: appi.properties.ConnectionString
    COSMOS_ACCOUNT: cosmos.name
    COSMOS_DATABASE: cosmosDb.name
  }
}

output swaName string = swa.name
output swaDefaultHostname string = swa.properties.defaultHostname
output cosmosAccount string = cosmos.name
output appInsightsConnectionString string = appi.properties.ConnectionString
output keyVaultName string = kv.name
