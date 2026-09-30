import type { User, UserGroup } from "@/lib/domain/types";

import { ago } from "./time";

/**
 * SYNTHETIC TEST DATA. All names, titles and addresses are invented.
 * The `folke.example` domain is reserved and cannot receive e-mail.
 */

export const DEMO_USER_ID = "u-01";

type UserSeed = Omit<User, "lastActiveAt"> & { lastActiveMinutesAgo: number | null };

const USER_SEEDS: UserSeed[] = [
  { id: "u-01", name: "Anna Lindqvist", email: "anna.lindqvist@folke.example", title: "Verksamhetsutvecklare", department: "Huvudkontor", location: "Anläggning Centrum", role: "system_admin", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 2 },
  { id: "u-02", name: "Erik Holmgren", email: "erik.holmgren@folke.example", title: "IT-ansvarig", department: "Huvudkontor", location: "Anläggning Centrum", role: "system_admin", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 95 },
  { id: "u-03", name: "Sara Nyström", email: "sara.nystrom@folke.example", title: "Försäljningschef", department: "Försäljning", location: "Anläggning Norr", role: "assistant_manager", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 30 },
  { id: "u-04", name: "Johan Berglund", email: "johan.berglund@folke.example", title: "Ekonomichef", department: "Ekonomi", location: "Anläggning Centrum", role: "assistant_manager", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 60 * 5 },
  { id: "u-05", name: "Maria Ekström", email: "maria.ekstrom@folke.example", title: "Verkstadschef", department: "Eftermarknad", location: "Anläggning Syd", role: "assistant_manager", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 60 * 26 },
  { id: "u-06", name: "Oskar Lundgren", email: "oskar.lundgren@folke.example", title: "Bilsäljare", department: "Försäljning", location: "Anläggning Norr", role: "employee", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 12 },
  { id: "u-07", name: "Elin Sjöberg", email: "elin.sjoberg@folke.example", title: "Bilsäljare", department: "Försäljning", location: "Anläggning Syd", role: "employee", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 60 * 3 },
  { id: "u-08", name: "Karl Wikström", email: "karl.wikstrom@folke.example", title: "Bilsäljare", department: "Försäljning", location: "Anläggning Centrum", role: "employee", status: "active", mfaEnrolled: false, lastActiveMinutesAgo: 60 * 48 },
  { id: "u-09", name: "Lina Forsberg", email: "lina.forsberg@folke.example", title: "Säljassistent", department: "Försäljning", location: "Anläggning Norr", role: "employee", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 60 * 7 },
  { id: "u-10", name: "Ahmed Karimi", email: "ahmed.karimi@folke.example", title: "Begagnatansvarig", department: "Försäljning", location: "Anläggning Syd", role: "employee", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 60 * 22 },
  { id: "u-11", name: "Petra Nilsson", email: "petra.nilsson@folke.example", title: "Controller", department: "Ekonomi", location: "Anläggning Centrum", role: "employee", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 60 * 2 },
  { id: "u-12", name: "Magnus Dahl", email: "magnus.dahl@folke.example", title: "VD", department: "Ledning", location: "Anläggning Centrum", role: "employee", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 60 * 30 },
  { id: "u-13", name: "Helena Björk", email: "helena.bjork@folke.example", title: "Marknadschef", department: "Marknad", location: "Anläggning Centrum", role: "employee", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 60 * 4 },
  { id: "u-14", name: "Fredrik Sandberg", email: "fredrik.sandberg@folke.example", title: "Servicetekniker", department: "Eftermarknad", location: "Anläggning Syd", role: "employee", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 60 * 9 },
  { id: "u-15", name: "Jonas Axelsson", email: "jonas.axelsson@folke.example", title: "Servicetekniker", department: "Eftermarknad", location: "Anläggning Norr", role: "employee", status: "active", mfaEnrolled: false, lastActiveMinutesAgo: 60 * 72 },
  { id: "u-16", name: "Camilla Strand", email: "camilla.strand@folke.example", title: "Garantihandläggare", department: "Eftermarknad", location: "Anläggning Syd", role: "employee", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 45 },
  { id: "u-17", name: "Niklas Hedlund", email: "niklas.hedlund@folke.example", title: "Servicemottagare", department: "Eftermarknad", location: "Anläggning Centrum", role: "employee", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 60 * 6 },
  { id: "u-18", name: "Therese Engström", email: "therese.engstrom@folke.example", title: "HR-specialist", department: "HR", location: "Anläggning Centrum", role: "employee", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 60 * 50 },
  { id: "u-19", name: "Viktor Palm", email: "viktor.palm@folke.example", title: "Bilsäljare", department: "Försäljning", location: "Anläggning Norr", role: "employee", status: "invited", mfaEnrolled: false, lastActiveMinutesAgo: null },
  { id: "u-20", name: "Ida Blom", email: "ida.blom@folke.example", title: "Ekonomiassistent", department: "Ekonomi", location: "Anläggning Centrum", role: "employee", status: "invited", mfaEnrolled: false, lastActiveMinutesAgo: null },
  { id: "u-21", name: "Tobias Lind", email: "tobias.lind@folke.example", title: "Servicetekniker", department: "Eftermarknad", location: "Anläggning Syd", role: "employee", status: "disabled", mfaEnrolled: true, lastActiveMinutesAgo: 60 * 24 * 41 },
  { id: "u-22", name: "Sofia Hansson", email: "sofia.hansson@folke.example", title: "Platschef", department: "Ledning", location: "Anläggning Norr", role: "employee", status: "active", mfaEnrolled: true, lastActiveMinutesAgo: 60 * 20 },
];

export function buildUsers(now: Date): User[] {
  return USER_SEEDS.map(({ lastActiveMinutesAgo, ...user }) => ({
    ...user,
    lastActiveAt:
      lastActiveMinutesAgo === null ? null : ago(now, { minutes: lastActiveMinutesAgo }),
  }));
}

export const GROUPS: UserGroup[] = [
  {
    id: "g-all",
    name: "Alla medarbetare",
    description: "Samtliga aktiva användare i Folke.",
    system: true,
    memberIds: USER_SEEDS.filter((u) => u.status !== "disabled").map((u) => u.id),
  },
  {
    id: "g-sales",
    name: "Försäljning",
    description: "Säljare och säljstöd på samtliga anläggningar.",
    memberIds: ["u-03", "u-06", "u-07", "u-08", "u-09", "u-10", "u-19"],
  },
  {
    id: "g-leadership",
    name: "Ledningsgrupp",
    description: "Koncernledning och platschefer.",
    memberIds: ["u-01", "u-03", "u-04", "u-05", "u-12", "u-13", "u-22"],
  },
  {
    id: "g-finance",
    name: "Ekonomi",
    description: "Ekonomiavdelningen, controllers och redovisning.",
    memberIds: ["u-04", "u-11", "u-20"],
  },
  {
    id: "g-workshop",
    name: "Verkstad",
    description: "Tekniker och servicemottagare inom eftermarknad.",
    memberIds: ["u-05", "u-14", "u-15", "u-17", "u-21"],
  },
  {
    id: "g-warranty",
    name: "Garantihandläggare",
    description: "Hanterar garantiärenden mot tillverkare.",
    memberIds: ["u-05", "u-16"],
  },
];
