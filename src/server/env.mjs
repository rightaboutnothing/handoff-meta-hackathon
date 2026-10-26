import dotenv from "dotenv";

dotenv.config({ quiet: true });

function requireEnvironmentVariable(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not set`);
  }

  return value;
}

export function getModelApiKey() {
  return requireEnvironmentVariable("MODEL_API_KEY");
}

export function getOpenRouterApiKey() {
  return requireEnvironmentVariable("OPENROUTER_API_KEY");
}
