import { describe, expect, it } from "vitest";

import { LISTING_TEXT, SYNTHETIC_CUSTOMER } from "./fixtures.test-helpers";
import { parseLeadText, vehicleFromSubject } from "./lead-fields";

describe("lead form parser", () => {
  it("reads a listing lead and treats placeholders as unknown", () => {
    const lead = parseLeadText(LISTING_TEXT);
    expect(lead.format).toBe("listing");
    expect(lead.source).toBe("Blocket");
    expect(lead.vehicle).toBe("Volkswagen ID.4");
    expect(lead.brand).toBe("Volkswagen");
    // "Virtuell", "-" and 0 are placeholders: never presented as values.
    expect(lead.regnr).toBeNull();
    expect(lead.model).toBeNull();
    expect(lead.mileageKm).toBeNull();
    expect(lead.carUrl).toBe("https://www.blocket.se/mobility/item/1");
    expect(lead.contact).toEqual({ name: true, email: true, phone: true });
    // Free text continues over unknown "label:" lines written by the customer.
    expect(lead.message).toBe("Hej! Finns bilen kvar?\nJag undrar också: kan ni ta inbyte?");
    expect(lead.personal.names).toContain(SYNTHETIC_CUSTOMER.name);
    expect(lead.personal.emails).toEqual([SYNTHETIC_CUSTOMER.email]);
  });

  it("reads real values when they are present and valid", () => {
    const lead = parseLeadText(
      ["Källa: Wayke", "Registreringsnummer: abc 12d", "Ämne: ABC12D - Volkswagen Passat", "Mätarställning: 4 500 mil", "Modell: Passat"].join("\n"),
    );
    expect(lead.regnr).toBe("ABC12D");
    expect(lead.vehicle).toBe("Volkswagen Passat");
    expect(lead.mileageKm).toBe(45_000);
    expect(lead.model).toBe("Passat");
  });

  it("reads the website form and the facility form", () => {
    const site = parseLeadText(
      ["Skickat från sida: https://www.example.com/kontakta-oss", "Anläggning: Teststad", "Telefon: 070-000 00 02", "Meddelande: Ring mig gärna"].join("\n"),
    );
    expect(site.format).toBe("website");
    expect(site.source).toBe("Hemsida");
    expect(site.facility).toBe("Teststad");
    expect(site.message).toBe("Ring mig gärna");
    expect(site.contact.phone).toBe(true);

    const facility = parseLeadText(
      ["facility: Teststad", "facility_email: forsaljning@folke.example", "Förnamn: Testa", "Efternamn: Kundsson", "Mobilnummer: 070-000 00 03", "Meddelande: Provkörning?"].join("\n"),
    );
    expect(facility.format).toBe("facility_form");
    expect(facility.personal.names).toEqual(expect.arrayContaining(["Testa", "Kundsson", "Testa Kundsson"]));
    // The dealer's own address is not the customer's.
    expect(facility.personal.emails).toEqual([]);
  });

  it("never invents values from text it does not recognise", () => {
    for (const text of ["", "Hej, jag vill köpa en bil.", "Pris: 100 kr\nFärg: blå", null, undefined]) {
      const lead = parseLeadText(text);
      expect(lead.format).toBe("unknown");
      expect([lead.source, lead.vehicle, lead.regnr, lead.model, lead.mileageKm, lead.carUrl, lead.message]).toEqual(
        Array(7).fill(null),
      );
    }
  });

  it("rejects malformed values instead of guessing", () => {
    const lead = parseLeadText(["Källa: Blocket", "Registreringsnummer: ABCD1234", "Bilkort URL: javascript:alert(1)", "Mätarställning: ca 5000"].join("\n"));
    expect(lead.regnr).toBeNull();
    expect(lead.carUrl).toBeNull();
    expect(lead.mileageKm).toBeNull();
  });

  it("reads the car only from subject forms we have seen", () => {
    expect(vehicleFromSubject("Nytt meddelande angående: Volkswagen Golf")).toBe("Volkswagen Golf");
    expect(vehicleFromSubject("Ang. Volkswagen ID.7")).toBe("Volkswagen ID.7");
    expect(vehicleFromSubject("Lead från : https://www.example.com/bil/1")).toBeNull();
    expect(vehicleFromSubject("Fråga")).toBeNull();
  });
});
