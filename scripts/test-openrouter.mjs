import { MODEL_ROUTES, routeText } from "../src/server/model-router.mjs";

const routeNames = ["grok", "gpt"];

const outputs = await Promise.all(
  routeNames.map(async (routeName) => ({
    model: MODEL_ROUTES[routeName].model,
    outputText: await routeText(routeName, "Say hello"),
  })),
);

for (const { model, outputText } of outputs) {
  console.log(`${model}: ${outputText}`);
}
