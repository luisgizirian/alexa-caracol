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

## 8. Cómo probarlo en la vida real (end-to-end)

Checklist antes de empezar: Function App desplegada (sección 4),
`skill-package/skill.json` con el endpoint real (no el placeholder) y, si vas
a usar el pipeline, los secretos/variables de la sección 7 ya configurados.

### 8.1 Dar de alta el skill en el Alexa Developer Console

Si aún no existe el skill ahí (solo hemos tocado el código, no el registro
en Amazon):

1. Instala la [ASK CLI](https://www.npmjs.com/package/ask-cli): `npm install -g ask-cli`.
2. `ask configure` (te pedirá login con tu cuenta de Amazon developer y crea
   un perfil).
3. Desde la raíz del repo: `ask deploy` — esto crea el skill a partir de
   `skill-package/` (manifiesto + modelo de interacción) y lo asocia a un
   `skillId` nuevo (se guarda en `.ask/`, no lo subas si contiene IDs que
   prefieras mantener privados, aunque no son secretos).
4. Alternativa sin CLI: crea el skill manualmente en
   https://developer.amazon.com/alexa/console/ask, pega el contenido de
   `skill-package/skill.json` en el JSON Editor del manifiesto y el de
   `interactionModels/custom/es-ES.json` en el JSON Editor del modelo de
   interacción (pestaña Build → Interaction Model → JSON Editor), y en
   Endpoint marca HTTPS con tu URL de la Function App.

### 8.2 Comprobación rápida del backend (antes de meter a Alexa)

El endpoint verifica firma/timestamp de Alexa (`verifySignatureAndTimestamp`),
así que un `curl` normal **debe fallar** — eso es la prueba de que la
verificación de seguridad está activa, no un fallo:

```bash
curl -i -X POST https://<tu-function-app>.azurewebsites.net/api/alexa/skill \
  -H "Content-Type: application/json" -d '{}'
# Esperado: 401/400 (falta la firma). Un 500 o "no se conecta" sí indica un problema real.
```

Para ver logs en vivo mientras pruebas desde el simulador o un dispositivo:

```bash
func azure functionapp logstream --name <tu-function-app> --resource-group rg-alexa-caracol
# o Azure Portal → tu Function App → Log stream / Application Insights → Live metrics
```

### 8.3 Probar en el simulador del Developer Console

1. Pestaña **Test** → activa el desplegable a "Development" (los skills sin
   publicar solo son testeables en este modo).
2. Escribe utterances de texto, por ejemplo:
   - "abre radio en directo"
   - "pon Caracol Radio Bogotá"
   - "pausa" / "reanuda"
3. Revisa el panel derecho (JSON Input/Output): debe aparecer una directiva
   `AudioPlayer.Play` con la URL del stream. El simulador web a veces no
   reproduce audio en directo indefinido de forma fiable — si no suena ahí,
   no es necesariamente un fallo del skill (ver 8.4).

### 8.4 Probar en un dispositivo Alexa real (la prueba que más importa)

1. El dispositivo (o la app oficial de Alexa) debe estar conectado con la
   **misma cuenta de Amazon** que usaste en `ask configure` / el Developer
   Console. No hace falta publicar el skill: en modo "Development" ya está
   disponible automáticamente en tus propios dispositivos.
2. Di: "Alexa, abre radio en directo" y luego "pon Caracol Radio Bogotá" (o
   invócalo todo junto: "Alexa, pide a radio en directo que ponga Caracol
   Radio Bogotá").
3. Comprueba pausa/reanudar y que al decir "para" se detenga limpiamente.
4. Si Alexa responde "hubo un problema con la skill solicitada", el fallo
   está casi siempre en el endpoint (mira los logs de 8.2) o en el manifiesto
   (endpoint mal apuntado, certificado no válido).

### 8.5 Probar el pipeline de CI/CD de extremo a extremo

1. Confirma que los secretos/variables de la sección 7 están puestos:
   `gh secret list --repo luisgizirian/alexa-caracol` y
   `gh variable list --repo luisgizirian/alexa-caracol`.
2. Haz un cambio trivial dentro de `azure-function/` (p. ej. un comentario) y
   haz push a `main`.
3. Sigue la ejecución del workflow:
   ```bash
   gh run watch --repo luisgizirian/alexa-caracol
   # o: gh run list --workflow=deploy.yml --repo luisgizirian/alexa-caracol
   ```
4. Si falla, revisa el log del paso concreto con `gh run view --log --repo luisgizirian/alexa-caracol`.
5. Repite el smoke test de 8.2 (o vuelve a probar por voz) para confirmar
   que la Function App desplegada responde con el cambio nuevo.

### 8.6 Problemas típicos

- **401/403 constante desde Alexa real pero el `curl` de 8.2 da el mismo
  error esperado**: revisa que el certificado de `*.azurewebsites.net` sea
  válido (lo es por defecto en Azure) y que el reloj del servidor esté
  sincronizado (la verificación de timestamp tolera ~150s de diferencia).
- **AudioPlayer no reproduce nada pero no hay error**: la URL del stream no
  es HTTPS, no es un formato soportado (MP3/AAC) o el servidor de streaming
  hace redirects que Alexa no sigue bien — prueba la URL directamente en un
  navegador o `curl -I` para confirmar que responde 200 con
  `Content-Type: audio/...`.
- **Funciona en el simulador pero no en el dispositivo (o al revés)**: es un
  falso negativo conocido del simulador web con streams en directo; confía
  más en la prueba con dispositivo real (8.4).
