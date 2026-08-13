(function exposePasskeyHelpers() {
  function decodeBase64Url(value) {
    const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
  }

  function encodeBase64Url(value) {
    const bytes = new Uint8Array(value);
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function registrationOptions(options) {
    return {
      ...options,
      challenge: decodeBase64Url(options.challenge),
      user: { ...options.user, id: decodeBase64Url(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((item) => ({ ...item, id: decodeBase64Url(item.id) })),
    };
  }

  function authenticationOptions(options) {
    return {
      ...options,
      challenge: decodeBase64Url(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((item) => ({ ...item, id: decodeBase64Url(item.id) })),
    };
  }

  function credentialToJSON(credential) {
    const response = credential.response;
    const json = {
      id: credential.id,
      rawId: encodeBase64Url(credential.rawId),
      response: {
        clientDataJSON: encodeBase64Url(response.clientDataJSON),
      },
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: credential.getClientExtensionResults(),
    };
    if (response.attestationObject) {
      json.response.attestationObject = encodeBase64Url(response.attestationObject);
      if (typeof response.getTransports === "function") json.response.transports = response.getTransports();
    } else {
      json.response.authenticatorData = encodeBase64Url(response.authenticatorData);
      json.response.signature = encodeBase64Url(response.signature);
      if (response.userHandle) json.response.userHandle = encodeBase64Url(response.userHandle);
    }
    return json;
  }

  window.kqhPasskey = { registrationOptions, authenticationOptions, credentialToJSON };
}());
