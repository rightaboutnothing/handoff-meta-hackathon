import { generateText } from "../src/server/model-router.mjs";

const outputText = await generateText("Say hello");

console.log(outputText);
