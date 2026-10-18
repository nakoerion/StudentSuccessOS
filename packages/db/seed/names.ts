/**
 * Hand-written synthetic name pools. Combinations are generated, so no seeded
 * person corresponds to a real individual. Well-known public figures' family
 * names are deliberately excluded.
 */
export interface NamePool {
  /** Locale for people drawn from this pool. */
  locale: string;
  male: readonly string[];
  female: readonly string[];
  family: readonly string[];
  /** Relative weight when a tenant draws from several pools. */
  weight: number;
}

export const ALBANIAN: NamePool = {
  locale: "sq",
  weight: 1,
  male: [
    "Arben", "Besnik", "Dritan", "Ermal", "Florian", "Gentian", "Ilir", "Klevis", "Luan", "Marsel",
    "Olsi", "Redon", "Sokol", "Taulant", "Erion", "Endrit", "Andi", "Altin", "Bledar", "Kristian",
  ],
  female: [
    "Ana", "Blerta", "Dorina", "Elira", "Fjona", "Greta", "Hana", "Ilda", "Jonida", "Klea",
    "Lira", "Megi", "Nora", "Rea", "Sara", "Teuta", "Vjosa", "Xhesika", "Anisa", "Era",
  ],
  family: [
    "Hoxha", "Shehu", "Gjoka", "Leka", "Kola", "Marku", "Dervishi", "Basha", "Prifti", "Çela",
    "Hysa", "Mema", "Duka", "Xhafa", "Brahimi", "Toska", "Bregu", "Malaj", "Zeneli", "Koçi",
  ],
};

export const EMIRATI: NamePool = {
  locale: "ar",
  weight: 4,
  male: ["Mohammed", "Ahmed", "Khalid", "Saeed", "Hamdan", "Rashid", "Sultan", "Omar", "Majid", "Faisal"],
  female: ["Fatima", "Mariam", "Aisha", "Noura", "Hessa", "Shamma", "Latifa", "Maitha", "Alya", "Reem"],
  family: ["Al Mansoori", "Al Hammadi", "Al Ketbi", "Al Dhaheri", "Al Shamsi", "Al Mazrouei", "Al Suwaidi", "Al Kaabi"],
};

export const LEVANTINE_EGYPTIAN: NamePool = {
  locale: "ar",
  weight: 2,
  male: ["Youssef", "Karim", "Tarek", "Ziad", "Omar", "Hadi", "Samir", "Adam"],
  female: ["Layla", "Rania", "Nour", "Hana", "Dina", "Yasmin", "Salma", "Lina"],
  family: ["Haddad", "Khoury", "Nasser", "Saleh", "Mansour", "Farouk", "Aziz", "Hamdi"],
};

export const SOUTH_ASIAN: NamePool = {
  locale: "en",
  weight: 2,
  male: ["Arjun", "Aditya", "Rohan", "Zain", "Imran", "Vikram", "Kabir", "Faraz"],
  female: ["Priya", "Ananya", "Ayesha", "Meera", "Sana", "Kavya", "Zara", "Diya"],
  family: ["Sharma", "Nair", "Iyer", "Khan", "Siddiqui", "Menon", "Qureshi", "Pillai"],
};

export const WESTERN_EXPAT: NamePool = {
  locale: "en",
  weight: 1,
  male: ["James", "Liam", "Lucas", "Noah", "Daniel", "Thomas", "Ethan", "Leo"],
  female: ["Emma", "Olivia", "Sofia", "Chloe", "Grace", "Isla", "Mia", "Ella"],
  family: ["Taylor", "Murphy", "Novak", "Walsh", "Fischer", "Bennett", "Moreau", "Kowalski"],
};
