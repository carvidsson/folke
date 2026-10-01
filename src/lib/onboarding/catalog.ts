import type { AnswerLength, WritingTone } from "@/lib/domain/preferences";

/**
 * Fixed, quality-checked examples for the example-based onboarding
 * (version 2). Choosing between them needs no AI call. Fictional content
 * only – no real customers, prices or terms.
 *
 * Step 1 shows ANSWER_EXAMPLES, step 2 WRITING_EXAMPLES, step 3 the quick
 * options (WRITING_OPTION_LABELS) plus optional free text and an optional
 * own writing sample.
 */

export const ANSWER_EXAMPLE_QUESTION = "Hur lång är leveranstiden för en ny bil just nu?";

export const ANSWER_EXAMPLES: Record<AnswerLength, string> = {
  short: "Normalt 10–12 veckor från order. [1]",
  balanced:
    "Leveranstiden är normalt 10–12 veckor från order. [1] För bilar som redan finns i lager kan leverans ske på 1–2 veckor. Ange gärna modell och utrustning, så kan jag kontrollera mer exakt.",
  detailed:
    "Leveranstiden är normalt 10–12 veckor från order. [1]\n\nSå här påverkas tiden:\n- **Lagerbilar** kan levereras på 1–2 veckor eftersom de redan finns i Sverige.\n- **Fabriksbeställda bilar** byggs efter order, och då gäller 10–12 veckor.\n- **Extrautrustning** som monteras efter leverans kan lägga till ungefär en vecka.\n\nOm kunden har ett datum att passa är det bäst att välja en lagerbil eller stämma av med försäljningsansvarig.",
};

export const WRITING_EXAMPLE_CONTEXT = "Bekräfta en provkörning med kunden Anna på torsdag kl. 14.";

export const WRITING_EXAMPLES: Record<WritingTone, { subject: string; body: string }> = {
  professional: {
    subject: "Bekräftelse av provkörning torsdag kl. 14",
    body: "Hej Anna,\n\nJag bekräftar härmed din provkörning på torsdag kl. 14. Bilen står klar vid entrén, och provkörningen tar cirka 30 minuter. Ta gärna med körkort.\n\nHör av dig om tiden behöver ändras.\n\nMed vänliga hälsningar",
  },
  personal: {
    subject: "Välkommen på provkörning på torsdag!",
    body: "Hej Anna!\n\nVad roligt att du vill provköra – vi ses på torsdag kl. 14. Jag har bilen redo när du kommer, så kan vi ta en tur på ungefär en halvtimme. Glöm inte körkortet.\n\nSäg bara till om tiden inte passar.\n\nVänliga hälsningar",
  },
  formal: {
    subject: "Bekräftelse: provkörning torsdagen kl. 14.00",
    body: "Bästa Anna,\n\nVi bekräftar härmed Er bokade provkörning torsdagen kl. 14.00. Fordonet finns tillgängligt vid vår entré och provkörningen beräknas omfatta cirka 30 minuter. Vi ber Er medtaga giltigt körkort.\n\nVänligen kontakta oss om tiden behöver ändras.\n\nMed vänlig hälsning",
  },
};
