// Scope
targetScope = 'subscription'

// INIT
param location string = 'swedencentral'
param prefix string = 'dokken'
param tags object = {}

@description('Workload name, used in the resource group and resource names.')
param workload string = 'whatabomb'

@description('''
App Service Plan SKU.
F1 (Free) is enough to serve the static single-player build, but it cannot host
the realtime multiplayer server: it has a hard 60 CPU-minutes/day quota, no
Always On, and no WebSocket support. Use B1 or higher once the game server ships.
''')
@allowed([
  'F1'
  'B1'
  'B2'
  'S1'
  'P0v3'
])
param appServicePlanSku string = 'B1'

@description('Linux runtime stack for the Web App.')
param linuxFxVersion string = 'NODE|22-lts'

@description('''
Container startup command.
`npm start` runs the Node server, which serves the Vite build *and* hosts the
WebSocket lobby. This must stay the default: the deploy workflow does not pass
a parameter file, so anything else here silently ships a broken app.
''')
param appCommandLine string = 'npm start'

// Free tier cannot run Always On, and VNet integration needs Basic or above.
var isFreeTier = appServicePlanSku == 'F1'

var resourceGroupName = 'rg-${prefix}-${workload}'
var appServicePlanName = 'asp-${prefix}-${workload}-${location}'
var webAppName = 'app-${prefix}-${workload}'

// Existing Resources
var resourceGroupNetworkName = 'rg-${prefix}-network'
resource resourceGroupNetwork 'Microsoft.Resources/resourceGroups@2025-04-01' existing = {
  name: resourceGroupNetworkName
}
resource virtualNetwork 'Microsoft.Network/virtualNetworks@2025-07-01' existing = {
  name: 'vnet-core-swedencentral'
  scope: az.resourceGroup(resourceGroupNetwork.name)
}
resource subnetWebApp 'Microsoft.Network/virtualNetworks/subnets@2025-07-01' existing = {
  name: 'snet-dokken-webapp'
  parent: virtualNetwork
}
// Resource Group
module resourceGroupWorkLoad 'br/public:avm/res/resources/resource-group:0.4.3' = {
  params: {
    name: resourceGroupName
    location: location
    tags: tags
  }
}

// App Service Plan
module appServicePlan 'br/public:avm/res/web/serverfarm:0.7.0' = {
  scope: az.resourceGroup(resourceGroupName)
  name: 'appServicePlanDeployment-${prefix}-${workload}'
  params: {
    name: appServicePlanName
    location: resourceGroupWorkLoad.outputs.location
    skuName: appServicePlanSku
    kind: 'Linux'
    // `kind: Linux` alone is not enough — without reserved:true ARM treats the
    // plan as Windows and rejects linuxFxVersion on the site.
    reserved: true
    // Neither Free nor Basic support zone redundancy.
    zoneRedundant: false
    tags: tags
    enableTelemetry: false
  }
}

// Web App
module webApp 'br/public:avm/res/web/site:0.24.0' = {
  scope: az.resourceGroup(resourceGroupName)
  name: 'webAppDeployment-${prefix}-${workload}'
  params: {
    name: webAppName
    location: resourceGroupWorkLoad.outputs.location
    kind: 'app,linux'
    serverFarmResourceId: appServicePlan.outputs.resourceId
    httpsOnly: true
    // VNet integration needs Basic or above, so it is skipped on F1 to keep
    // that SKU selectable rather than failing the deployment outright.
    virtualNetworkSubnetResourceId: isFreeTier ? null : subnetWebApp.id
    siteConfig: {
      linuxFxVersion: linuxFxVersion
      appCommandLine: appCommandLine
      alwaysOn: !isFreeTier
      // Required for the multiplayer WebSocket endpoint.
      webSocketsEnabled: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'FtpsOnly'
    }
    configs: [
      {
        name: 'appsettings'
        properties: {
          // The pipeline ships a prebuilt package with production node_modules
          // already installed, so Oryx must not try to build on the server —
          // the package deliberately contains no sources and no devDependencies.
          SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'
          WEBSITE_NODE_DEFAULT_VERSION: '~22'
        }
      }
    ]
    tags: tags
    enableTelemetry: false
  }
}

// OUTPUTS
// `.name` on a module is its deployment name, not the resource group name.
output resourceGroupNameOut string = resourceGroupWorkLoad.outputs.name
output webAppNameOut string = webAppName
output webAppUrl string = 'https://${webApp.outputs.defaultHostname}'
