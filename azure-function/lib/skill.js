const Alexa = require('ask-sdk-core');
const STATIONS = require('./stations');

const HELP_MESSAGE = 'Puedes decir, pon Caracol Radio Bogotá, o pon RAC1. ¿Qué emisora quieres escuchar?';

function resolveStationId(handlerInput) {
  const slots = handlerInput.requestEnvelope.request.intent.slots;
  const slot = slots && slots.emisora;
  const resolutions = slot && slot.resolutions && slot.resolutions.resolutionsPerAuthority;
  if (resolutions && resolutions[0] && resolutions[0].status.code === 'ER_SUCCESS_MATCH') {
    return resolutions[0].values[0].value.id;
  }
  return null;
}

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  handle(handlerInput) {
    const speakOutput = 'Bienvenido a la radio en directo. ' + HELP_MESSAGE;
    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(HELP_MESSAGE)
      .getResponse();
  }
};

const PlayStationIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'ReproducirEmisoraIntent';
  },
  async handle(handlerInput) {
    const stationId = resolveStationId(handlerInput);
    if (!stationId || !STATIONS[stationId]) {
      const speakOutput = 'No he reconocido esa emisora. ' + HELP_MESSAGE;
      return handlerInput.responseBuilder.speak(speakOutput).reprompt(HELP_MESSAGE).getResponse();
    }

    const attributesManager = handlerInput.attributesManager;
    const persistentAttributes = (await attributesManager.getPersistentAttributes()) || {};
    persistentAttributes.lastStationId = stationId;
    attributesManager.setPersistentAttributes(persistentAttributes);
    await attributesManager.savePersistentAttributes();

    const station = STATIONS[stationId];
    return handlerInput.responseBuilder
      .speak(`Reproduciendo ${station.title}.`)
      .addAudioPlayerPlayDirective('REPLACE_ALL', station.url, stationId, 0, 0, null)
      .withShouldEndSession(true)
      .getResponse();
  }
};

const PauseIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.PauseIntent';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.addAudioPlayerStopDirective().getResponse();
  }
};

const ResumeIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ResumeIntent';
  },
  async handle(handlerInput) {
    const attributesManager = handlerInput.attributesManager;
    const persistentAttributes = (await attributesManager.getPersistentAttributes()) || {};
    const stationId = persistentAttributes.lastStationId;
    const station = STATIONS[stationId];

    if (!station) {
      const speakOutput = 'No hay ninguna emisora en pausa. ' + HELP_MESSAGE;
      return handlerInput.responseBuilder.speak(speakOutput).reprompt(HELP_MESSAGE).getResponse();
    }

    return handlerInput.responseBuilder
      .speak(`Reanudando ${station.title}.`)
      .addAudioPlayerPlayDirective('REPLACE_ALL', station.url, stationId, 0, 0, null)
      .withShouldEndSession(true)
      .getResponse();
  }
};

const StopOrCancelIntentHandler = {
  canHandle(handlerInput) {
    const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent');
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak('Hasta luego.')
      .addAudioPlayerStopDirective()
      .withShouldEndSession(true)
      .getResponse();
  }
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.speak(HELP_MESSAGE).reprompt(HELP_MESSAGE).getResponse();
  }
};

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
  },
  handle(handlerInput) {
    const speakOutput = 'No te he entendido. ' + HELP_MESSAGE;
    return handlerInput.responseBuilder.speak(speakOutput).reprompt(HELP_MESSAGE).getResponse();
  }
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.getResponse();
  }
};

// Los eventos de AudioPlayer no admiten respuesta con voz, solo directivas o respuesta vacía.
const AudioPlayerEventHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope).startsWith('AudioPlayer.');
  },
  handle(handlerInput) {
    const requestType = Alexa.getRequestType(handlerInput.requestEnvelope);
    if (requestType === 'AudioPlayer.PlaybackFailed') {
      console.error('AudioPlayer.PlaybackFailed', JSON.stringify(handlerInput.requestEnvelope.request.error));
    }
    return handlerInput.responseBuilder.getResponse();
  }
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error(error);
    const speakOutput = 'Se ha producido un error al intentar reproducir la emisora.';
    return handlerInput.responseBuilder.speak(speakOutput).getResponse();
  }
};

// Construye el SkillBuilder sin invocar .lambda()/.create() para que el host
// (Azure Function, Lambda, servidor Express propio, etc.) decida cómo exponerlo.
function buildSkillBuilder(persistenceAdapter) {
  const builder = Alexa.SkillBuilders.custom()
    .addRequestHandlers(
      LaunchRequestHandler,
      PlayStationIntentHandler,
      PauseIntentHandler,
      ResumeIntentHandler,
      StopOrCancelIntentHandler,
      HelpIntentHandler,
      FallbackIntentHandler,
      SessionEndedRequestHandler,
      AudioPlayerEventHandler
    )
    .addErrorHandlers(ErrorHandler);

  if (persistenceAdapter) {
    builder.withPersistenceAdapter(persistenceAdapter);
  }

  return builder;
}

module.exports = { buildSkillBuilder };
