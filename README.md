# Alexa Skill: Radio en directo (Caracol Radio Bogotá / RAC1)

Skill de Alexa que usa la interfaz **AudioPlayer** para reproducir streams de
radio en directo, alojado en **Azure Functions** (no AWS Lambda).

```
skill-package/
  skill.json                          # manifiesto (endpoint HTTPS de Azure + interfaz AUDIO_PLAYER)
  interactionModels/custom/es-ES.json # intents y slot EMISORA (Caracol / RAC1)
azure-function/
  host.json
  package.json
  local.settings.json.example         # copia a local.settings.json para desarrollo local
  AlexaSkillFunction/
    function.json                     # HTTP trigger, ruta POST /api/alexa/skill
    index.js                          # Express + ask-sdk-express-adapter + azure-function-express
  lib/
    skill.js                          # handlers del skill (ask-sdk-core)
    stations.js                       # URLs de streaming
    azureTablePersistenceAdapter.js   # persistencia (Azure Table Storage) en vez de DynamoDB
```

## 1. URLs de streaming

- **Caracol Radio Bogotá**: `https://16643.live.streamtheworld.com/CARACOL_RADIOAAC.aac`
  (facilitada por el usuario; originalmente en `http://`, aquí forzada a
  `https://` porque AudioPlayer exige TLS — pruébala en el simulador de Alexa
  antes de publicar, por si ese host no sirve TLS en ese endpoint concreto).
- **RAC1 Barcelona**: pendiente. Localízala con las DevTools del navegador
  (Network → filtra `.m3u8`/`.aac`/`.mp3` mientras reproduces en la web/app
  oficial) y sustituye el placeholder en
  [azure-function/lib/stations.js](azure-function/lib/stations.js).

Revisa los términos de uso de cada emisora: retransmitir su señal desde un
skill de terceros puede requerir autorización explícita del propietario.

## 2. Por qué Azure Functions en vez de AWS Lambda

Alexa admite dos tipos de endpoint para un skill custom:
- **ARN de Lambda** (AWS): Alexa invoca la función directamente; no requiere
  verificar la firma porque el propio trust boundary es la invocación Lambda.
- **URL HTTPS** (cualquier hosting, incluido Azure Functions): Alexa hace un
  POST HTTP normal, así que **hay que verificar la firma y el timestamp de
  cada petición** para asegurarte de que viene realmente de Alexa y no de un
  tercero. Por eso `AlexaSkillFunction/index.js` usa
  [`ask-sdk-express-adapter`](https://www.npmjs.com/package/ask-sdk-express-adapter)
  con `verifySignatureAndTimestamp = true` y `verifyTimestamp = true`, y
  [`azure-function-express`](https://www.npmjs.com/package/azure-function-express)
  para exponer esa app Express dentro de una Azure Function HTTP trigger.

La persistencia (recordar la última emisora para "reanudar") tampoco puede
usar DynamoDB: se implementó un `AzureTablePersistenceAdapter` propio sobre
Azure Table Storage (`@azure/data-tables`), ya que ask-sdk no trae un adapter
oficial para Azure.

## 3. Desarrollo local

```bash
cd azure-function
cp local.settings.json.example local.settings.json
npm install
npm start   # requiere Azure Functions Core Tools (func)
```

Expón el puerto local con una herramienta de túnel (ngrok, etc.) si quieres
probarlo desde el simulador de Alexa antes de desplegar.

## 4. Despliegue a Azure

```bash
az login
az group create --name rg-alexa-caracol --location westeurope
az storage account create --name <storage-unico> --resource-group rg-alexa-caracol --sku Standard_LRS
az functionapp create --resource-group rg-alexa-caracol --consumption-plan-location westeurope \
  --runtime node --runtime-version 20 --functions-version 4 \
  --name <nombre-unico-function-app> --storage-account <storage-unico>

az functionapp config appsettings set --name <nombre-unico-function-app> --resource-group rg-alexa-caracol \
  --settings AZURE_STORAGE_CONNECTION_STRING="<connection-string-de-la-storage-account>" AZURE_TABLE_NAME="AlexaCaracolState"

func azure functionapp publish <nombre-unico-function-app>
```

Después, actualiza `skill-package/skill.json` con la URL real:

```
https://<nombre-unico-function-app>.azurewebsites.net/api/alexa/skill
```

y despliega el modelo/manifiesto del skill con `ask deploy` (o subiéndolo a
mano en el Alexa Developer Console, pestaña Endpoint → HTTPS, marcando el
certificado como "My development endpoint is a sub-domain of a domain that
has a wildcard certificate..." según corresponda al certificado que use tu
Function App).

## 5. Cómo funciona el skill

- **LaunchRequest**: da la bienvenida y pide la emisora.
- **ReproducirEmisoraIntent** (slot `emisora`): resuelve "Caracol Radio
  Bogotá" o "RAC1" al id interno y emite una directiva `AudioPlayer.Play`
  (`REPLACE_ALL`) con la URL del stream.
- **AMAZON.PauseIntent / StopIntent / CancelIntent**: `AudioPlayer.Stop`.
- **AMAZON.ResumeIntent**: recupera la última emisora reproducida (guardada
  en Azure Table Storage) y la vuelve a reproducir.
- Handlers `AudioPlayer.*` (PlaybackStarted/Finished/Stopped/Failed): responden
  vacío, como exige la especificación.

## 6. Pruebas por voz

- "Alexa, abre radio en directo" → "pon Caracol Radio Bogotá"
- "Alexa, pide a radio en directo que ponga RAC1"
- "Alexa, pausa" / "Alexa, reanuda"

## 7. CI/CD con GitHub Actions

El workflow [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
despliega `azure-function/` a Azure Functions en cada push a `main` que toque
esa carpeta. Usa **login OIDC** (`azure/login`) en vez de un publish profile
o un secreto de contraseña de larga duración, por lo que primero hay que dar
de alta un *service principal* de Azure con una *federated credential* que
confíe en GitHub Actions. Esto solo se configura una vez, desde una máquina
con `az` autenticado (no lo puede hacer este asistente, que no tiene acceso a
tu suscripción de Azure):

```bash
# Variables de partida
GH_REPO="luisgizirian/alexa-caracol"
RESOURCE_GROUP="rg-alexa-caracol"          # el mismo que uses para el Function App
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
APP_NAME="gh-alexa-caracol-deploy"

# 1. App registration (identidad) — sin secretos de cliente, solo federated credentials
APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
az ad sp create --id "$APP_ID"   # crea el service principal asociado a la app

# 2. Rol Contributor acotado al resource group del Function App (no a toda la suscripción)
az role assignment create --assignee "$APP_ID" \
  --role "Contributor" \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP"

# 3. Federated credential: confía en tokens OIDC de GitHub Actions para este repo/rama
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-main-branch",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:luisgizirian/alexa-caracol:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

# El workflow usa además "environment: production" a nivel de job; si en GitHub
# creas ese Environment (Settings → Environments) para añadir reglas de protección,
# añade también esta credencial (si no, la de la rama "main" ya es suficiente):
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-production-environment",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:luisgizirian/alexa-caracol:environment:production",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

Después, da de alta los secretos/variables en el repo de GitHub (con `gh`
CLI o desde Settings → Secrets and variables → Actions):

```bash
gh secret set AZURE_CLIENT_ID --repo "$GH_REPO" --body "$APP_ID"
gh secret set AZURE_TENANT_ID --repo "$GH_REPO" --body "$TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --repo "$GH_REPO" --body "$SUBSCRIPTION_ID"
gh variable set AZURE_FUNCTIONAPP_NAME --repo "$GH_REPO" --body "<nombre-de-tu-function-app>"
```

Notas de seguridad:
- No se usan secretos de cliente (`client secret`) ni publish profiles: OIDC
  emite un token de corta duración por cada ejecución, así que no hay
  credenciales de larga duración que filtrar.
- El rol `Contributor` se otorga solo sobre el resource group del Function
  App, no sobre toda la suscripción.
- Si más adelante restringes el `subject` de la federated credential a un
  `environment` de GitHub con reglas de aprobación manual, tendrás una
  protección extra antes de desplegar a producción.
