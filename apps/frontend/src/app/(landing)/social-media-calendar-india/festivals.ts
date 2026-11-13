// One page per big festival under /social-media-calendar-india/<slug>, for the
// date questions people actually ask ("diwali 2026 date", "holi 2027 date").
// The hub is the page ChatGPT cites most; these are its spokes, and each links
// back to it.
//
// No date is typed in this file. Every date comes from a CALENDAR row
// (calendar-data.ts, which cites the DoPT lists), found by occasion and year;
// a row that is not there fails the build in rowFor(). The prose below is
// written so that it stays true for the dates those rows hold.
import { CALENDAR, CalendarRow } from './calendar-data';

interface RowRef {
  occasion: string;
  year: number;
}

export interface FestivalPage {
  slug: string;
  /** "Diwali 2026": the H1 subject and breadcrumb name. */
  name: string;
  title: string;
  description: string;
  main: RowRef;
  /** A second headline date, stated right after the first (Bakrid on the Eid page). */
  alsoMain?: RowRef;
  /** Other days shown with it: the run-up, the follow-ups, same-day clashes. */
  related: RowRef[];
  /** One or two sentences after the date sentence. */
  context: string;
  ideas: { title: string; text: string }[];
  timing: string[];
}

export const rowFor = ({ occasion, year }: RowRef): CalendarRow => {
  const row = CALENDAR.find(
    (r) => r.occasion === occasion && r.date.startsWith(`${year}-`)
  );
  if (!row) {
    throw new Error(`calendar-data.ts has no "${occasion}" in ${year}`);
  }
  return row;
};

const FLAG_NOTE =
  'Keep the national flag itself out of sale creatives: the Flag Code of India governs how it may be displayed, and Indian law restricts using it for trade. Tricolour colours and your own imagery are fine.';

export const FESTIVALS: FestivalPage[] = [
  {
    slug: 'diwali-2026',
    name: 'Diwali 2026',
    title: 'Diwali 2026: Date and Social Media Post Ideas | Hookpost',
    description:
      'Diwali 2026 date from the Government of India (DoPT) holiday list, the days around it, and five post ideas with when to schedule each.',
    main: { occasion: 'Diwali', year: 2026 },
    related: [
      { occasion: 'Dussehra (Vijaya Dashami)', year: 2026 },
      { occasion: 'Karwa Chauth', year: 2026 },
      { occasion: 'Govardhan Puja', year: 2026 },
      { occasion: 'Bhai Dooj', year: 2026 },
      { occasion: 'Chhath Puja', year: 2026 },
    ],
    context:
      'For most consumer brands it is the biggest greeting of the year. Karwa Chauth comes ten days before it and Bhai Dooj three days after, so the festive run on social media starts in late October and ends in mid-November.',
    ideas: [
      {
        title: 'A countdown teaser, 7-10 days out',
        text: 'Say what you are running (an offer, a launch, a gift guide) and the day it starts. People plan Diwali shopping early, and a teaser gives the greeting on the day something to land on.',
      },
      {
        title: 'A gift guide by budget',
        text: 'A carousel sorted by price (under ₹500, under ₹2,000, above) works for retail and D2C brands. A services business can post what clients should wrap up before the holiday week instead.',
      },
      {
        title: 'Behind the scenes of the festive rush',
        text: 'Orders being packed, the office rangoli, the team on the last working day. Real photos of your people do better than stock diyas; ask before you post anyone.',
      },
      {
        title: 'The greeting, on the morning of the day',
        text: 'Short, warm and without a discount in it. Schedule it for early morning India time so it is waiting when people open their phones.',
      },
      {
        title: 'A thank-you after the festival',
        text: 'Govardhan Puja and Bhai Dooj follow within three days. A thank-you to customers works there, and if you ran a sale, one honest number (orders shipped, families served) beats a generic message.',
      },
    ],
    timing: [
      'Write everything a week ahead and schedule it, including the greeting: on the day itself nobody on your team will want to post by hand.',
      'Bhai Dooj is a gifting day for retail and D2C brands, so its post needs the same lead time as the Diwali teaser.',
      'Chhath Puja follows a week later and matters most in Bihar, Jharkhand and eastern UP. Localise if you have audiences there.',
    ],
  },
  {
    slug: 'holi-2027',
    name: 'Holi 2027',
    title: 'Holi 2027: Date and Social Media Post Ideas | Hookpost',
    description:
      'Holi 2027 and Holika Dahan dates from the Government of India (DoPT) holiday list, with five post ideas and when to schedule them.',
    main: { occasion: 'Holi', year: 2027 },
    related: [
      { occasion: 'Maha Shivratri', year: 2027 },
      { occasion: "International Women's Day", year: 2027 },
      { occasion: 'Holika Dahan', year: 2027 },
      { occasion: 'Good Friday', year: 2027 },
    ],
    context:
      'Holika Dahan is the evening before. Holi is one of the most shared festival days of the year, and it is visual: colour, short video and photos of people do the work.',
    ideas: [
      {
        title: 'A Holika Dahan teaser the evening before',
        text: 'One post the day before that sets up what you will share on Holi itself: a colour palette, a product in festival packaging, a team photo to come.',
      },
      {
        title: 'A short colour video',
        text: 'Ten to fifteen seconds of colour (your product, your shop, your team) outperforms a designed poster on Instagram Reels and YouTube Shorts.',
      },
      {
        title: 'Skin, hair and clean-up tips',
        text: 'Beauty, health and home-care brands can post what to do before and after playing with colours. Keep it practical and do not make medical claims.',
      },
      {
        title: 'Your team’s celebration',
        text: 'A before-and-after photo of the office celebration, posted with everyone’s consent, says more about your company than a greeting card.',
      },
      {
        title: 'A regional greeting',
        text: 'In Bengal and Odisha the festival is Dol Jatra, and the local date can differ from the central list by a day. If your audience is there, a greeting in Bengali or Odia reads better than a generic one.',
      },
    ],
    timing: [
      'Schedule the Holi post for the morning: by afternoon people are outdoors and off their phones.',
      'Good Friday falls three days later. Keep promotions off that day for Christian audiences.',
    ],
  },
  {
    slug: 'republic-day-2027',
    name: 'Republic Day 2027',
    title: 'Republic Day 2027: Date and Post Ideas | Hookpost',
    description:
      'Republic Day 2027 date from the Government of India (DoPT) holiday list, five post ideas, and how to use the tricolour in creatives.',
    main: { occasion: 'Republic Day', year: 2027 },
    related: [
      { occasion: 'National Youth Day', year: 2027 },
      { occasion: 'Makar Sankranti / Magh Bihu', year: 2027 },
      { occasion: 'Pongal / Guru Gobind Singh Jayanti', year: 2027 },
      { occasion: 'Basant Panchami', year: 2027 },
    ],
    context:
      'It marks the day the Constitution of India came into force in 1950. Many brands run a sale; decide early whether you will, because the announcement needs a few days of lead time.',
    ideas: [
      {
        title: 'A made-in-India story',
        text: 'Where your product is made or who builds it, with names and faces. Specific beats patriotic: one workshop, one team, one city.',
      },
      {
        title: 'A line from the Preamble',
        text: 'Justice, liberty, equality and fraternity, tied to one thing your company actually does. Quote it accurately and keep the product out of the frame.',
      },
      {
        title: 'The sale announcement, if you run one',
        text: 'Post the dates and terms three to five days ahead, then a reminder on the morning of the day. If you are not running one, leave discounts out entirely.',
      },
      {
        title: 'A post before the parade',
        text: 'The parade in New Delhi is on television in the morning. Schedule the greeting for early morning so it is up before it starts.',
      },
      {
        title: 'Your team across India',
        text: 'Where your people or customers come from, state by state, with their permission. It fits the day better than a stock tricolour graphic.',
      },
    ],
    timing: [
      'Makar Sankranti and Pongal come less than two weeks earlier, so January has two greeting days close together. Write both in the same sitting.',
      FLAG_NOTE,
    ],
  },
  {
    slug: 'independence-day-2027',
    name: 'Independence Day 2027',
    title: 'Independence Day 2027: Date and Post Ideas | Hookpost',
    description:
      'Independence Day 2027 date from the Government of India (DoPT) holiday list, the festivals on the same day, and five post ideas.',
    main: { occasion: 'Independence Day', year: 2027 },
    related: [
      { occasion: 'Milad-un-Nabi (subject to moon sighting)', year: 2027 },
      { occasion: 'Parsi New Year (Navroz)', year: 2027 },
      { occasion: 'Raksha Bandhan', year: 2027 },
      { occasion: 'Janmashtami', year: 2027 },
    ],
    context:
      'In 2027 it shares the day with Milad-un-Nabi (subject to moon sighting) and Parsi New Year, and Raksha Bandhan follows two days later. Plan separate posts rather than one combined greeting.',
    ideas: [
      {
        title: 'A made-in-India or local-maker story',
        text: 'The people, places and suppliers behind your product. A named person and a real photo carry the day better than a flag graphic.',
      },
      {
        title: 'What changed for your customers',
        text: 'A short before-and-after of a problem your product removed for one customer, told with their permission. Keep the freedom metaphor light.',
      },
      {
        title: 'The sale, announced a few days before',
        text: 'Many brands run an Independence Day sale. If you do, post the dates and terms a few days ahead, not on the morning itself.',
      },
      {
        title: 'Separate greetings for the same day',
        text: 'If your audience observes Milad-un-Nabi or Navroz, give each its own respectful post at a different hour rather than folding them into one.',
      },
      {
        title: 'The Raksha Bandhan run-up',
        text: 'Gifting brands start Rakhi teasers 7-10 days ahead, which means they overlap with Independence Day. Schedule both runs in advance so neither crowds the other.',
      },
    ],
    timing: [
      'Schedule the Independence Day post for early morning; the flag-hoisting at the Red Fort is in the morning.',
      FLAG_NOTE,
    ],
  },
  {
    slug: 'eid-2027',
    name: 'Eid 2027',
    title: 'Eid 2027: Id-ul-Fitr and Bakrid Dates, Post Ideas | Hookpost',
    description:
      'Id-ul-Fitr and Id-ul-Zuha (Bakrid) 2027 dates from the Government of India (DoPT) holiday list, both subject to moon sighting, with post ideas.',
    main: { occasion: 'Id-ul-Fitr (subject to moon sighting)', year: 2027 },
    alsoMain: { occasion: 'Id-ul-Zuha (Bakrid, subject to moon sighting)', year: 2027 },
    related: [{ occasion: 'Muharram (subject to moon sighting)', year: 2027 }],
    context:
      'Id-ul-Fitr marks the end of Ramzan. Both Eid dates depend on the moon sighting and can move by a day, so plan for either day.',
    ideas: [
      {
        title: 'An Eid Mubarak greeting, with a draft for each possible day',
        text: 'Schedule the greeting for the listed date and keep a copy ready for the next day. If the moon is sighted later, move the post on your calendar the evening before.',
      },
      {
        title: 'Ramzan content in the weeks before',
        text: 'Food, grocery and delivery brands can post around iftar and sehri during the month. Keep it useful (timings, recipes, late delivery hours) rather than promotional.',
      },
      {
        title: 'Recipes and food',
        text: 'Sheer khurma, biryani and the dishes your audience makes on the day. A short recipe video is shared widely.',
      },
      {
        title: 'Eidi and gifting',
        text: 'Eidi, the gifts and money given to children, suits gifting, fashion and fintech brands. A gift guide works the week before.',
      },
      {
        title: 'A respectful greeting for Bakrid',
        text: 'Keep the Id-ul-Zuha post a greeting: warm, short and without a sale in it. The same one-day uncertainty applies.',
      },
    ],
    timing: [
      'Write both Eid posts at the start of the month they fall in, and check the moon-sighting news the evening before.',
      'Muharram is a day of mourning for many. No celebratory or sales posts on that day.',
    ],
  },
];

export const festivalBySlug = (slug: string) =>
  FESTIVALS.find((f) => f.slug === slug);
