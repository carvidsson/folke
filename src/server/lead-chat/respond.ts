import "server-only";

/**
 * Answers the Leadanalys assistant gives without AI (ADR-050): questions outside the material, no
 * access, and periods Folke has not fetched. Deterministic, so they cannot drift or invent anything.
 */

const OUT_OF_SCOPE: Record<string, string> = {
  sales:
    "Leadanalys innehåller inte försäljningsresultat eller affärer – bara hur leads tas emot och besvaras i HubSpot, och sparade AI-bedömningar av dialogerna. Jag kan inte säga något om vad som såldes. Jag kan däremot visa svarstider, leadskällor eller vad som fungerar i dialogerna.",
  forecast:
    "Leadanalys gör inga prognoser. Jag kan visa hur det har sett ut under en period och jämföra med föregående period.",
  ranking:
    "Jag rangordnar inte säljare och ger inga betyg. Jag kan beskriva svarstider och mönster för en säljare eller ett team som stöd för coachning, med underlaget synligt.",
  customer:
    "Leadanalys sparar inga kunduppgifter eller dialogtexter, så jag kan inte svara på vad en enskild kund skrev. Originaldialogen finns i HubSpot – jag kan visa exempel med länk dit.",
};

export function outOfScopeAnswer(topic: string): string {
  return OUT_OF_SCOPE[topic] ?? OUT_OF_SCOPE.sales;
}

export const NO_LEAD_ACCESS = "Du har inte tillgång till Leadanalys. Be en systemadministratör om åtkomst om du behöver den.";

export const NO_INBOXES = "Det finns inga aktiva inkorgar i Leadanalys som du har tillgång till ännu.";

