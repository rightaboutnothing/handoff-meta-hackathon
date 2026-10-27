import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEMO_SEED = 20261027;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const warning = "SYNTHETIC DEMO DATA. Acme Filtration Pty Ltd is fictional. Every person, contact, account, product and business fact below is fake. Do not use operationally.";
const document = (heading, text) => `# ${heading}\n\n${warning}\n\n${text.trim()}\n`;
const files = {
  "products/af100.md": document("AF100 product specification", `The AF100 is a 1 micron carbon cartridge system for a small workshop.
Maximum flow: 12 litres per minute. Maximum operating pressure: 600 kPa.
Height: 420 mm. Dry weight: 6 kg. List price: AUD 1290 excluding GST.
Warranty: 24 months. Replacement cartridge code: C100. Routine replacement interval: 6 months.
No electrical power is required.`),
  "products/af200.md": document("AF200 product specification", `The AF200 is a commercial system with two 1 micron cartridges in parallel.
Maximum flow: 24 litres per minute. Maximum operating pressure: 1000 kPa.
Height: 610 mm. Dry weight: 11 kg. List price: AUD 2490 excluding GST.
Warranty: 24 months. Replacement cartridge code: C200. Routine replacement interval: 4 months.
No electrical power is required. Reliability probabilities are not specified.`),
  "products/af300.md": document("AF300 product specification", `The AF300 is an industrial 0.5 micron membrane system.
Maximum flow: 48 litres per minute. Maximum operating pressure: 1200 kPa.
Height: 920 mm. Dry weight: 28 kg. List price: AUD 4990 excluding GST.
Warranty: 36 months. Replacement membrane code: M300. Routine replacement interval: 12 months.
The monitoring module requires a 24 volt DC supply.`),
  "policies/returns.md": document("Returns and warranty policy", `Unopened standard products may be returned within 30 calendar days with a return authorisation.
There is no restocking fee. Custom products cannot be returned for a change of mind.
Warranty claims require the serial number and proof of purchase. Report transit damage within 48 hours.
The customer pays change-of-mind return freight. Acme pays freight for a confirmed warranty defect.`),
  "policies/service.md": document("Support service policy", `Support hours are Monday to Friday, 08:00 to 17:00 AWST.
Urgent tickets have a first-response target of 2 business hours. Standard tickets have a first-response target of 8 business hours.
In-stock parts dispatch within 1 business day. Escalate unresolved urgent tickets to the service lead after 4 business hours.
Name: Priya Finch
Role: Service Lead
Email: priya.finch@example.test
Phone: +61 8 5550 0101
Arrival rates and service-time distributions are not supplied.`),
  "policies/shipping.md": document("Shipping policy", `Western Australia metro delivery target: 3 business days. Other Australian destinations: 7 business days.
Free standard freight applies to orders of at least AUD 1500 excluding GST. Below that threshold, standard freight is AUD 35.
Custom product lead time is 15 business days. The dispatch cutoff is 14:00 AWST; later orders enter the next business day's queue.`),
  "policies/discounts.md": document("Volume discounts", `For identical products on one order, quantities of 10 to 24 receive a 5 percent discount and quantities of 25 or more receive an 8 percent discount.
Discounts apply before GST, exclude freight and cannot be stacked. Quotes remain valid for 30 days.
Discounts outside these bands require sales manager approval.
Name: Ellis Vale
Role: Sales Manager
Email: ellis.vale@example.test
Phone: +61 8 5550 0102`),
  "policies/security.md": document("Data handling policy", `Retain support tickets for 180 days after closure. Only authorised support staff may access customer contact details.
Marketing exports must exclude customer phone numbers. Product performance reports must exclude customer email addresses and phone numbers.
Review access permissions every 90 days. Report a suspected data incident within 1 hour.
Use product codes, amounts and issue categories for analysis rather than personal fields.`),
  "hr/handbook.md": document("HR handbook", `Full-time staff receive 20 days of annual leave and 10 days of personal leave per year.
The probation period is 6 months. Complete safety training within 30 days and product training within 90 days of starting.
Submit expense claims within 14 days. The overnight-travel meal allowance is AUD 65 per day.
Name: Hannah Wren
Role: People Lead
Email: hannah.wren@example.test
Phone: +61 8 5550 0103`),
  "sales/northshore.md": document("Northshore trial sales notes", `The fictional Northshore Trial opportunity requests 20 AF300 units and has an indicative budget of AUD 110000.
The customer's decision date is 15 November 2026. Requested delivery is December 2026.
The minimum required flow is 40 litres per minute. The contract is unsigned.
customer_name: Morgan Reed
Email: morgan.reed@example.test
Phone: +61 8 5550 0104
Installation labour cost, site pressure, competitor quotes, conversion probability and payment timing are not provided.`),
  "sales/forecast.md": document("Quarterly sales snapshot", `For the quarter ended 30 September 2026, booked units were AF100: 40; AF200: 30; AF300: 10.
The next-quarter revenue target is AUD 250000. No price changes have been approved.
The sales channel split is 60 percent direct and 40 percent partner.
Demand distributions, customer-level margins, price elasticity and capacity constraints are not available.`),
  "operations/stock.md": document("Spare-part inventory policy", `Reorder points: C100 20 units; C200 16 units; M300 8 units.
Safety stock: C100 10 units; C200 8 units; M300 4 units. Supplier lead time is 10 business days.
Count spare parts every Friday. Rush orders require operations manager approval.
Demand variance, supplier-delay correlation and a service-level probability model are not supplied.`),
  "README.md": document("Acme Filtration synthetic company dataset", `These records are deliberately invented for an offline private-gateway demonstration.
All contacts use example.test addresses and invented 5550 phone numbers. There are no real customers or employees.
The evaluation has 60 questions: 36 lookups, 16 questions combining facts, and 8 advanced reasoning questions requiring missing-input caveats.
Seed: ${DEMO_SEED}. Run node scripts/generate-company-demo.mjs to reproduce every byte.
Only this synthetic dataset belongs in git. Ingest real company files from a separate folder into ignored local storage.
evaluation.jsonl and manifest.json are evaluation metadata and must not be ingested as source documents.`),
};

const tickets = [
  ["T1001", "Ava Marlow", "AF100", "standard", "closed", "low flow", "replaced C100 cartridge"],
  ["T1002", "Noah Linden", "AF200", "urgent", "open", "housing leak", "awaiting seal inspection"],
  ["T1003", "Mia Hartley", "AF300", "standard", "closed", "sensor warning", "recalibrated monitoring module"],
  ["T1004", "Leo Bennett", "AF100", "standard", "open", "order tracking", "carrier investigation pending"],
  ["T1005", "Isla Rowan", "AF200", "standard", "closed", "low flow", "replaced C200 cartridges"],
  ["T1006", "Ethan Brook", "AF300", "urgent", "closed", "power fault", "replaced 24 volt supply"],
  ["T1007", "Zoe Alder", "AF100", "standard", "closed", "transit damage", "approved warranty replacement"],
  ["T1008", "Oscar Fern", "AF200", "urgent", "open", "pressure alarm", "pressure measurement scheduled"],
  ["T1009", "Ruby Ash", "AF300", "standard", "open", "membrane order", "quote supplied"],
  ["T1010", "Lucas Grove", "AF100", "standard", "closed", "installation question", "supplied installation guide"],
];
files["support/tickets.csv"] = "synthetic_data,ticket_id,customer_name,email,phone,product,severity,status,issue,resolution\n" + tickets.map(([id, name, ...fields], index) => ["FAKE SYNTHETIC RECORD", id, name, `${name.toLowerCase().replace(" ", ".")}@example.test`, `+61 8 5550 ${String(201 + index).padStart(4, "0")}`, ...fields].join(",")).join("\n") + "\n";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const source = (file, location = "page:1") => ({ file, chunkId: `${hash(file).slice(0, 12)}:${location.replaceAll(":", "-")}:0001` });
const questions = [];
const add = (category, prompt, answer, requiredFacts, sources, options = {}) => questions.push({
  id: `acme-${String(questions.length + 1).padStart(3, "0")}`, suite: "company-rag", synthetic: true, category, prompt,
  reference: { answer, requiredFacts, sources: sources.map((item) => typeof item === "string" ? source(item) : item) },
  expectedSourceFiles: sources.map((item) => typeof item === "string" ? item : item.file),
  expectedChunkIds: sources.map((item) => typeof item === "string" ? source(item).chunkId : item.chunkId),
  requiresCloud: category === "cloud", ...options,
});

for (const [model, flow, pressure, price, code, interval] of [["AF100", 12, 600, 1290, "C100", 6], ["AF200", 24, 1000, 2490, "C200", 4], ["AF300", 48, 1200, 4990, "M300", 12]]) {
  const file = `products/${model.toLowerCase()}.md`;
  add("lookup", `What is the maximum flow of the ${model}?`, `${flow} litres per minute.`, [String(flow)], [file]);
  add("lookup", `What is the maximum operating pressure of the ${model}?`, `${pressure} kPa.`, [String(pressure)], [file]);
  add("lookup", `What is the ${model} list price before GST?`, `AUD ${price} excluding GST.`, [String(price)], [file]);
  add("lookup", `What replacement cartridge or membrane code does the ${model} use?`, code, [code], [file]);
  add("lookup", `What is the routine replacement interval for the ${model}?`, `${interval} months.`, [String(interval)], [file]);
}
add("lookup", "Within how many calendar days can an unopened standard product be returned?", "30 calendar days with a return authorisation.", ["30"], ["policies/returns.md"]);
add("lookup", "Is a restocking fee charged on an eligible standard return?", "No restocking fee.", [["no restocking fee", "no fee", "no", "zero"]], ["policies/returns.md"]);
add("lookup", "What two documents or identifiers does a warranty claim require?", "Serial number and proof of purchase.", ["serial", "proof of purchase"], ["policies/returns.md"]);
add("lookup", "How soon should transit damage be reported?", "Within 48 hours.", ["48"], ["policies/returns.md"]);
add("lookup", "What is the first-response target for an urgent support ticket?", "2 business hours.", ["2"], ["policies/service.md"]);
add("lookup", "What is the first-response target for a standard support ticket?", "8 business hours.", ["8"], ["policies/service.md"]);
add("lookup", "What are support opening hours and timezone?", "Monday to Friday, 08:00 to 17:00 AWST.", [["08:00", "8:00", "8 am", "8am"], ["17:00", "5 pm", "5pm"], "AWST"], ["policies/service.md"]);
add("lookup", "What is the Western Australia metro delivery target?", "3 business days.", ["3"], ["policies/shipping.md"]);
add("lookup", "What order value qualifies for free standard freight?", "At least AUD 1500 excluding GST.", ["1500"], ["policies/shipping.md"]);
add("lookup", "What is standard freight below the free-freight threshold?", "AUD 35.", ["35"], ["policies/shipping.md"]);
add("lookup", "How many days after closure are support tickets retained?", "180 days.", ["180"], ["policies/security.md"]);
add("lookup", "How often are access permissions reviewed?", "Every 90 days.", ["90"], ["policies/security.md"]);
add("lookup", "How many annual leave days do full-time staff receive?", "20 days each year.", ["20"], ["hr/handbook.md"]);
add("lookup", "How long is the staff probation period?", "6 months.", ["6"], ["hr/handbook.md"]);
add("lookup", "Within how many days must a new employee finish product training?", "90 days.", ["90"], ["hr/handbook.md"]);
add("lookup", "What is the C100 reorder point?", "20 units.", ["20"], ["operations/stock.md"]);
add("lookup", "What is the Northshore Trial customer decision date?", "15 November 2026.", ["15", "November", "2026"], ["sales/northshore.md"]);
add("lookup", "What is the Northshore Trial indicative budget?", "AUD 110000.", ["110000"], ["sales/northshore.md"]);
add("lookup", "What is the status of support ticket T1002?", "Open.", ["open"], [source("support/tickets.csv", "row:3")]);
add("lookup", "What fixed the power fault on ticket T1006?", "Replaced the 24 volt supply.", ["24", "supply"], [source("support/tickets.csv", "row:7")]);
add("lookup", "What is the People Lead's email address in the synthetic HR handbook?", "hannah.wren@example.test", ["hannah.wren@example.test"], ["hr/handbook.md"], { testsLocalPiiRestoration: true });

add("multi_document", "Compare the maximum flows of AF100 and AF200.", "AF100: 12 litres/minute; AF200: 24 litres/minute.", ["AF100", "12", "AF200", "24"], ["products/af100.md", "products/af200.md"]);
add("multi_document", "Compare the pressure limits of AF200 and AF300.", "AF200: 1000 kPa; AF300: 1200 kPa.", ["AF200", "1000", "AF300", "1200"], ["products/af200.md", "products/af300.md"]);
add("multi_document", "Compare the warranties for AF100 and AF300.", "AF100: 24 months; AF300: 36 months.", ["24", "36"], ["products/af100.md", "products/af300.md"]);
add("multi_document", "Would AF100 or AF300 meet Northshore Trial's minimum flow, and why?", "AF300 delivers 48 litres/minute, exceeding the 40 minimum. AF100 delivers only 12.", ["AF300", "48", "40", "12"], ["sales/northshore.md", "products/af100.md", "products/af300.md"]);
add("multi_document", "At list price before GST, does one AF100 qualify for free freight? What freight applies?", "No. AUD 1290 is below 1500; freight is AUD 35.", ["1290", "1500", "35"], ["products/af100.md", "policies/shipping.md"]);
add("multi_document", "At list price before GST, does one AF200 qualify for free freight?", "Yes. AUD 2490 exceeds the AUD 1500 threshold.", ["2490", "1500", ["free", "yes"]], ["products/af200.md", "policies/shipping.md"]);
add("multi_document", "Which volume-discount band applies to Northshore Trial's requested quantity?", "20 AF300 units qualify for the 5 percent band.", ["20", "5"], ["sales/northshore.md", "policies/discounts.md"]);
add("multi_document", "What is the per-unit AF100 price before GST on an order for 10 identical units?", "AUD 1225.50 after a 5 percent discount.", ["1225.5", "5"], ["products/af100.md", "policies/discounts.md"]);
add("multi_document", "What is the per-unit AF300 price before GST on an order for 25 identical units?", "AUD 4590.80 after an 8 percent discount.", ["4590.8", "8"], ["products/af300.md", "policies/discounts.md"]);
add("multi_document", "For ticket T1002, what first-response target applies under the service policy?", "It is urgent, so the target is 2 business hours.", ["urgent", "2"], [source("support/tickets.csv", "row:3"), "policies/service.md"]);
add("multi_document", "What product and published pressure limit are associated with ticket T1008?", "AF200, maximum 1000 kPa.", ["AF200", "1000"], [source("support/tickets.csv", "row:9"), "products/af200.md"]);
add("multi_document", "Which replacement was used on T1001, and what is that part's reorder point?", "C100 cartridge; reorder at 20 units.", ["C100", "20"], [source("support/tickets.csv", "row:2"), "operations/stock.md"]);
add("multi_document", "Which product had the most booked units last quarter, and what is its maximum flow?", "AF100 had 40 booked units and a 12 litre/minute maximum flow.", ["AF100", "40", "12"], ["sales/forecast.md", "products/af100.md"]);
add("multi_document", "Compare the Northshore AF300 requested quantity with AF300 booked units last quarter.", "Northshore requests 20; last quarter booked 10, so it is twice as many.", ["20", "10"], ["sales/northshore.md", "sales/forecast.md"]);
add("multi_document", "State the annual leave allowance and expense-claim deadline from the HR handbook.", "20 days annual leave; submit expenses within 14 days.", ["20", "14"], ["hr/handbook.md"]);
add("multi_document", "When analysing support tickets for a product performance report, which contact fields must be omitted?", "Exclude customer email addresses and phone numbers; use product codes and issue categories.", [["email", "emails"], ["phone", "phones"], ["exclude", "omit", "remove"]], [source("support/tickets.csv", "row:2"), "policies/security.md"]);

const cloud = (prompt, answer, facts, sources) => add("cloud", prompt, answer, facts, sources, { rubric: "Advanced reasoning: identify missing inputs, state assumptions, offer a defensible method, and never invent company facts. A safe cloud handoff may help, but no cloud can recover absent business data." });
cloud("Derive a stochastic inventory policy for all three spare parts that guarantees a 99.5 percent service level under correlated supplier delays. Use only the supplied company data and identify what is missing.", "Cannot guarantee the target without demand variance and supplier correlation. Define a stochastic inventory model and request missing inputs.", [["demand", "variance"], ["correlation", "correlated"], ["missing", "not supplied", "not provided", "cannot"]], ["operations/stock.md"]);
cloud("Prove a numerical reliability advantage for AF200's parallel arrangement over AF100, accounting for common-mode failure. If the evidence is insufficient, give a reliability model and the missing inputs.", "Specify independent and common-mode failure probabilities; the specifications do not provide them, so no numerical proof is justified.", [["probability", "probabilities", "failure rate"], ["common", "correlation"], ["missing", "not provided", "not specified", "cannot"]], ["products/af100.md", "products/af200.md"]);
cloud("Develop a constrained deployment optimisation for the Northshore Trial including labour cost, site pressure, staged delivery and budget uncertainty. Give a model, not invented numbers.", "Use the 20 AF300 request and 110000 budget, model constraints, and request missing labour and site inputs.", [["constraint", "constraints"], "labour", ["missing", "not provided", "unknown"]], ["sales/northshore.md", "products/af300.md"]);
cloud("Design a causal experiment to test whether replacement cartridges reduce repeat low-flow tickets, accounting for confounders and statistical power. Explain limits of this tiny synthetic sample.", "Randomise or control confounding, define recurrence and observation windows, and obtain a larger sample for a power calculation.", [["random", "randomise", "randomize", "control"], ["power", "sample size"], ["confounder", "confounders", "confounding"]], [source("support/tickets.csv", "row:2"), source("support/tickets.csv", "row:6")]);
cloud("Formulate robust AF100 and AF200 pricing optimisation when demand elasticity and competitor responses are unknown. Explain what additional evidence is required.", "Use a robust optimisation or scenario model and obtain elasticity and competitor data before recommending prices.", ["elasticity", ["scenario", "scenarios", "robust"], ["competitor", "competitors"]], ["products/af100.md", "products/af200.md", "sales/forecast.md"]);
cloud("Build a multi-period cash-flow risk model for winning the Northshore Trial. Handle unknown conversion probability, payment timing and capacity without fabricating forecasts.", "Specify uncertain conversion and payment scenarios, capacity constraints and cash-flow periods; request missing inputs.", [["conversion", "probability"], ["payment", "payments"], ["scenario", "scenarios", "missing", "unknown"]], ["sales/northshore.md", "sales/forecast.md"]);
cloud("Specify a Bayesian hierarchical product-failure model using these support tickets with right-censored exposure. State why the supplied records cannot identify numerical failure rates.", "A model needs exposure, censoring and product-level partial pooling or priors. Tickets alone lack the installed-base denominator.", ["exposure", ["prior", "priors", "pooling", "hierarchical"], ["missing", "lack", "cannot", "not provided"]], [source("support/tickets.csv", "row:2"), source("support/tickets.csv", "row:3")]);
cloud("Derive a priority queueing model to size support staffing for urgent and standard response targets, including uncertainty and a validation plan. Identify inputs not present in the documents.", "Need arrival rates and service-time distributions, model priority queues, and validate against observed response-time data.", [["arrival", "arrivals"], ["service time", "service-time", "service times"], ["missing", "not supplied", "not provided", "need"]], ["policies/service.md", source("support/tickets.csv", "row:3")]);

function random(seed) { let value = seed; return () => { value += 0x6D2B79F5; let t = value; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export async function generateCompanyDemo(destination = path.join(root, "demo_data")) {
  if (questions.length !== 60) throw new Error(`Expected 60 questions; got ${questions.length}`);
  const shuffled = [...questions]; const rng = random(DEMO_SEED);
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  for (const [file, contents] of Object.entries(files)) { const target = path.join(destination, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, contents, "utf8"); }
  const jsonl = shuffled.map((item) => JSON.stringify(item)).join("\n") + "\n";
  await writeFile(path.join(destination, "evaluation.jsonl"), jsonl, "utf8");
  const categories = Object.fromEntries([...new Set(questions.map((item) => item.category))].map((category) => [category, questions.filter((item) => item.category === category).length]));
  const manifest = { synthetic: true, seed: DEMO_SEED, company: "Acme Filtration Pty Ltd (fictional)", questionCount: questions.length, categories, evaluationSha256: hash(jsonl), files: Object.entries(files).map(([file, text]) => ({ file, sha256: hash(text) })) };
  await writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await generateCompanyDemo();
  console.log(`Generated ${manifest.files.length} synthetic documents and ${manifest.questionCount} questions; seed ${manifest.seed}; ${JSON.stringify(manifest.categories)}.`);
}
