using './main.bicep'

param location = 'swedencentral'
param prefix = 'dokken'
param workload = 'whatabomb'

// B1 is the cheapest SKU that can host the realtime game server.
// F1 cannot: 60 CPU-minutes/day quota, no Always On, no WebSockets.
param appServicePlanSku = 'B1'

param linuxFxVersion = 'NODE|22-lts'

// The Node server serves the Vite build and hosts the WebSocket lobby.
param appCommandLine = 'npm start'

param tags = {
  workload: 'whatabomb'
  environment: 'prod'
  managedBy: 'bicep'
}
