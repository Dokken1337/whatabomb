using './main.bicep'

param location = 'belgiumcentral'
param prefix = 'dokken'
param workload = 'whatabomb'

// B1 is the cheapest SKU that can host the realtime game server.
// F1 cannot: 60 CPU-minutes/day quota, no Always On, no WebSockets.
param appServicePlanSku = 'B1'

// Two instances. Safe only because lobby state and the socket fan-out both
// live in Redis — see the appServicePlanCapacity description in main.bicep.
param appServicePlanCapacity = 2

// Smallest Azure Managed Redis tier; the workload is a few small lobby records
// plus pub/sub traffic that is never retained.
param redisSkuName = 'Balanced_B0'

param linuxFxVersion = 'NODE|22-lts'

// The Node server serves the Vite build and hosts the WebSocket lobby.
param appCommandLine = 'npm start'

param tags = {
  workload: 'whatabomb'
  environment: 'prod'
  managedBy: 'bicep'
}
