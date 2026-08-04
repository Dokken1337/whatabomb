// Scope
targetScope = 'subscription'

// INIT
param location string = 'belgiumcentral'
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

@description('''
Instance count for the App Service Plan.

More than one instance is only safe because lobby state lives in Redis and every
cross-instance message is fanned out over Redis pub/sub. Without that, a host
creates a lobby on instance A while their friend's join is load-balanced to
instance B, which has never heard of that code — which is exactly the "no lobby
with that code" failure this stack was built to fix. Do not scale out without
`REDIS_URL` configured.
''')
@minValue(1)
param appServicePlanCapacity int = 2

@description('''
Azure Managed Redis SKU. Balanced_B0 is the smallest tier and is ample: the only
thing stored is a handful of small lobby records, plus pub/sub traffic that is
never retained.
''')
param redisSkuName string = 'Balanced_B0'

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
var redisName = 'amr-${prefix}-${workload}'

// Existing Resources
var resourceGroupNetworkName = 'rg-${prefix}-network'
resource resourceGroupNetwork 'Microsoft.Resources/resourceGroups@2025-04-01' existing = {
  name: resourceGroupNetworkName
}
resource virtualNetwork 'Microsoft.Network/virtualNetworks@2025-07-01' existing = {
  name: 'vnet-core-${location}'
  scope: az.resourceGroup(resourceGroupNetwork.name)
}
resource subnetWebApp 'Microsoft.Network/virtualNetworks/subnets@2025-07-01' existing = {
  name: 'snet-${prefix}-webapp'
  parent: virtualNetwork
}
// Redis is reached over a private endpoint, which lands in the dedicated
// subnet (it is the one with privateEndpointNetworkPolicies disabled).
resource subnetPrivateEndpoints 'Microsoft.Network/virtualNetworks/subnets@2025-07-01' existing = {
  name: 'snet-${prefix}-private-endpoints'
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
    // One instance, always — see appServicePlanCapacity.
    skuCapacity: appServicePlanCapacity
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

// Private DNS for the Redis private endpoint.
//
// `privatelink.redis.azure.net` is the zone Azure Managed Redis expects; the
// endpoint's own DNS zone group writes the A record into it, and the VNet link
// is what lets the Web App resolve the cache to its private address instead of
// its public one.
module redisPrivateDnsZone 'br/public:avm/res/network/private-dns-zone:0.8.1' = {
  scope: az.resourceGroup(resourceGroupName)
  name: 'redisDnsZoneDeployment-${prefix}-${workload}'
  params: {
    name: 'privatelink.redis.azure.net'
    virtualNetworkLinks: [
      {
        name: 'link-${prefix}-${workload}-vnet-core'
        virtualNetworkResourceId: virtualNetwork.id
        registrationEnabled: false
      }
    ]
    tags: tags
    enableTelemetry: false
  }
}

// Azure Managed Redis
//
// Holds the lobby records and carries the pub/sub fan-out between App Service
// instances. Both jobs are required for multi-instance play: the records make a
// lobby code resolvable from any instance, and the fan-out lets a message reach
// a player whose WebSocket is pinned to a different one.
module redis 'br/public:avm/res/cache/redis-enterprise:0.5.1' = {
  scope: az.resourceGroup(resourceGroupName)
  name: 'redisDeployment-${prefix}-${workload}'
  params: {
    name: redisName
    location: resourceGroupWorkLoad.outputs.location
    skuName: redisSkuName
    // Reachable only from the VNet. The Web App's VNet integration is what
    // gives it a route in; nothing else needs to talk to this cache.
    publicNetworkAccess: 'Disabled'
    privateEndpoints: [
      {
        name: 'pep-${redisName}'
        // Pinned to the VNet's region, not the cache's: a private endpoint must
        // be in the same region as its virtual network, even when the resource
        // it targets sits elsewhere.
        location: resourceGroupWorkLoad.outputs.location
        subnetResourceId: subnetPrivateEndpoints.id
        privateDnsZoneGroup: {
          name: 'default'
          privateDnsZoneGroupConfigs: [
            {
              name: 'privatelink-redis'
              privateDnsZoneResourceId: redisPrivateDnsZone.outputs.resourceId
            }
          ]
        }
        tags: tags
      }
    ]
    database: {
      accessKeysAuthentication: 'Enabled'
      clusteringPolicy: 'NoCluster'
      clientProtocol: 'Encrypted'
      evictionPolicy: 'NoEviction'
    }
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
    // Send outbound traffic through the integration subnet. Without this the
    // app resolves and dials Redis over the internet, which its private
    // endpoint has now closed off — so the cache would simply be unreachable.
    outboundVnetRouting: isFreeTier ? null : {
      allTraffic: true
    }
    siteConfig: {
      linuxFxVersion: linuxFxVersion
      appCommandLine: appCommandLine
      alwaysOn: !isFreeTier
      // Required for the multiplayer WebSocket endpoint.
      webSocketsEnabled: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'FtpsOnly'
      // Lobbies are held in the server process's memory, so a second instance
      // would host a second, invisible set of them and a shared code would
      // resolve on one worker and not the other. Pinned to one worker until the
      // store is backed by something shared (see server/lobby-store.ts).
      numberOfWorkers: 1
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
          // Shared lobby state and the cross-instance relay. Without this the
          // server falls back to a per-process store, which is only correct on
          // a single instance.
          REDIS_URL: 'rediss://:${redis.outputs.?primaryAccessKey}@${redis.outputs.hostName}:${redis.outputs.port}'
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
