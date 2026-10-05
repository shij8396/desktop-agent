(function () {
  'use strict';

  function isEnabled(prefs) {
    return prefs?.voicePreferenceVersion === 2 && prefs.voiceEnabled === true;
  }

  function update(prefs, enabled) {
    return { ...(prefs || {}), voiceEnabled: enabled === true, voicePreferenceVersion: 2 };
  }

  window.AssistantVoicePreference = { isEnabled, update };
})();
