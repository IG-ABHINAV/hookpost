// Festival and observance dates for the Indian social media calendar page.
// Holidays are from the Government of India's DoPT holiday lists: the 2026 list
// (O.M. F.No.12/2/2023-JCA dated 3 July 2025) and the 2027 list (O.M. dated
// 16 July 2026), gazetted and restricted (Delhi/New Delhi). Fixed-date
// observances need no source; "Observance" rows follow a weekday rule (Mother's
// Day: second Sunday of May; Father's Day: third Sunday of June). Checked 28 Sep
// 2026; April-December 2027 added on 11 Oct 2026 from the 2027 O.M.
// (Annexure I gazetted, Annexure II restricted). Durga Puja 2026 added on 11 Oct
// 2026: the 2026 O.M. Annexure II lists Dussehra (Saptami) 18 Oct Sunday,
// (Mahashtami) 19 Oct Monday and (Mahanavmi) 20 Oct Tuesday; Drik Panchang's
// Kolkata calendar and timeanddate.com give the same Saptami and Ashtami dates.
// The same rows are published as public/social-media-calendar-india-2026-27.csv
// and .ics: run `node scripts/india-calendar-files.js` after editing.
export type CalendarKind = 'Gazetted holiday' | 'Restricted holiday' | 'Fixed-date observance' | 'Observance';
export interface CalendarRow { date: string; weekday: string; occasion: string; kind: CalendarKind; idea: string }
export const CALENDAR: CalendarRow[] = [
  {
    "date": "2026-10-02",
    "weekday": "Fri",
    "occasion": "Gandhi Jayanti",
    "kind": "Gazetted holiday",
    "idea": "A quote or value from Gandhi tied to how your business works. Avoid discount-led posts on this day."
  },
  {
    "date": "2026-10-18",
    "weekday": "Sun",
    "occasion": "Durga Puja: Maha Saptami (Ashtami 19 Oct, Navami 20 Oct)",
    "kind": "Restricted holiday",
    "idea": "Bengal and the east. A short series across Saptami, Ashtami and Navami; Navratri runs in the north at the same time."
  },
  {
    "date": "2026-10-20",
    "weekday": "Tue",
    "occasion": "Dussehra (Vijaya Dashami)",
    "kind": "Gazetted holiday",
    "idea": "Good-over-evil framing: a problem your product fixes. Navratri runs for the nine nights before it, so a 9-post series works."
  },
  {
    "date": "2026-10-26",
    "weekday": "Mon",
    "occasion": "Maharishi Valmiki Jayanti",
    "kind": "Restricted holiday",
    "idea": "Regional audiences in North India. A short greeting is enough."
  },
  {
    "date": "2026-10-29",
    "weekday": "Thu",
    "occasion": "Karwa Chauth",
    "kind": "Restricted holiday",
    "idea": "Gifting, fashion, beauty and food brands. Schedule the post for the morning; the fast ends at moonrise."
  },
  {
    "date": "2026-11-08",
    "weekday": "Sun",
    "occasion": "Diwali",
    "kind": "Gazetted holiday",
    "idea": "Your biggest greeting of the year. Schedule the sale teaser 7-10 days out and the greeting for the morning of the day."
  },
  {
    "date": "2026-11-09",
    "weekday": "Mon",
    "occasion": "Govardhan Puja",
    "kind": "Restricted holiday",
    "idea": "Follow-up greeting; also a natural day to thank customers after Diwali."
  },
  {
    "date": "2026-11-11",
    "weekday": "Wed",
    "occasion": "Bhai Dooj",
    "kind": "Restricted holiday",
    "idea": "Sibling-gifting angle for retail and D2C brands."
  },
  {
    "date": "2026-11-14",
    "weekday": "Sat",
    "occasion": "Children's Day",
    "kind": "Fixed-date observance",
    "idea": "Education, toys, kids’ food and family brands. Throwback photos from your team work well."
  },
  {
    "date": "2026-11-15",
    "weekday": "Sun",
    "occasion": "Chhath Puja",
    "kind": "Restricted holiday",
    "idea": "Important in Bihar, Jharkhand and eastern UP. Localise if you have audiences there."
  },
  {
    "date": "2026-11-24",
    "weekday": "Tue",
    "occasion": "Guru Nanak Jayanti",
    "kind": "Gazetted holiday",
    "idea": "A respectful greeting. Keep product promotion out of it."
  },
  {
    "date": "2026-12-24",
    "weekday": "Thu",
    "occasion": "Christmas Eve",
    "kind": "Restricted holiday",
    "idea": "Gift-guide and last-order-date posts for delivery businesses."
  },
  {
    "date": "2026-12-25",
    "weekday": "Fri",
    "occasion": "Christmas",
    "kind": "Gazetted holiday",
    "idea": "Greeting plus a year-end offer if you run one."
  },
  {
    "date": "2026-12-31",
    "weekday": "Thu",
    "occasion": "New Year's Eve",
    "kind": "Fixed-date observance",
    "idea": "Year-in-review carousel: numbers, launches, thank-yous."
  },
  {
    "date": "2027-01-01",
    "weekday": "Fri",
    "occasion": "New Year's Day",
    "kind": "Restricted holiday",
    "idea": "Plans or resolutions for your customers, not for you."
  },
  {
    "date": "2027-01-12",
    "weekday": "Tue",
    "occasion": "National Youth Day",
    "kind": "Fixed-date observance",
    "idea": "Swami Vivekananda’s birth anniversary. Students, education and career audiences."
  },
  {
    "date": "2027-01-14",
    "weekday": "Thu",
    "occasion": "Makar Sankranti / Magh Bihu",
    "kind": "Restricted holiday",
    "idea": "Kites and harvest imagery; the festival has different names by state, so localise the greeting."
  },
  {
    "date": "2027-01-15",
    "weekday": "Fri",
    "occasion": "Pongal / Guru Gobind Singh Jayanti",
    "kind": "Restricted holiday",
    "idea": "Tamil audiences for Pongal; Sikh audiences for Guru Gobind Singh Jayanti. Two separate, respectful greetings."
  },
  {
    "date": "2027-01-26",
    "weekday": "Tue",
    "occasion": "Republic Day",
    "kind": "Gazetted holiday",
    "idea": "Made-in-India and constitution themes. Many brands run sales; decide early if you will."
  },
  {
    "date": "2027-02-11",
    "weekday": "Thu",
    "occasion": "Basant Panchami",
    "kind": "Restricted holiday",
    "idea": "Yellow palette, learning and new beginnings. Suits education brands."
  },
  {
    "date": "2027-02-14",
    "weekday": "Sun",
    "occasion": "Valentine's Day",
    "kind": "Fixed-date observance",
    "idea": "Gifting, food and experiences. Schedule the week-long run-up from 7 February."
  },
  {
    "date": "2027-02-19",
    "weekday": "Fri",
    "occasion": "Chhatrapati Shivaji Maharaj Jayanti",
    "kind": "Restricted holiday",
    "idea": "Big in Maharashtra. A respectful greeting in Marathi lands better than an English one."
  },
  {
    "date": "2027-03-06",
    "weekday": "Sat",
    "occasion": "Maha Shivratri",
    "kind": "Restricted holiday",
    "idea": "A respectful greeting. Keep promotion light."
  },
  {
    "date": "2027-03-08",
    "weekday": "Mon",
    "occasion": "International Women's Day",
    "kind": "Fixed-date observance",
    "idea": "Spotlight the women on your team or among your customers, with their permission."
  },
  {
    "date": "2027-03-10",
    "weekday": "Wed",
    "occasion": "Id-ul-Fitr (subject to moon sighting)",
    "kind": "Gazetted holiday",
    "idea": "Greeting on the day. The date can move by a day, so keep a draft ready for both."
  },
  {
    "date": "2027-03-22",
    "weekday": "Mon",
    "occasion": "Holika Dahan",
    "kind": "Restricted holiday",
    "idea": "Teaser for Holi content the next day."
  },
  {
    "date": "2027-03-23",
    "weekday": "Tue",
    "occasion": "Holi",
    "kind": "Gazetted holiday",
    "idea": "Colour-heavy creatives and short video. One of the most shared festival days of the year."
  },
  {
    "date": "2027-03-26",
    "weekday": "Fri",
    "occasion": "Good Friday",
    "kind": "Gazetted holiday",
    "idea": "A quiet day for Christian audiences. Skip promotions."
  },
  {
    "date": "2027-03-28",
    "weekday": "Sun",
    "occasion": "Easter Sunday",
    "kind": "Restricted holiday",
    "idea": "Greeting for Christian audiences; spring and family imagery for food and gifting brands."
  },
  {
    "date": "2027-04-07",
    "weekday": "Wed",
    "occasion": "Gudi Padwa / Ugadi / Cheti Chand / Navratri begins",
    "kind": "Restricted holiday",
    "idea": "Regional new year in Maharashtra, Karnataka, Andhra Pradesh, Telangana and for Sindhi audiences. Localise the greeting by state."
  },
  {
    "date": "2027-04-14",
    "weekday": "Wed",
    "occasion": "Vaisakhi / Vishu / Tamil New Year",
    "kind": "Restricted holiday",
    "idea": "Harvest and new-year greetings for Punjab, Kerala and Tamil Nadu. Three short regional versions beat one generic post."
  },
  {
    "date": "2027-04-15",
    "weekday": "Thu",
    "occasion": "Ram Navami",
    "kind": "Gazetted holiday",
    "idea": "A respectful greeting. Keep product promotion out of it."
  },
  {
    "date": "2027-04-15",
    "weekday": "Thu",
    "occasion": "Bahag Bihu / Vaisakhadi (Bengali New Year)",
    "kind": "Restricted holiday",
    "idea": "Assamese and Bengali new year on the same day. Worth a regional post if you have audiences in the east."
  },
  {
    "date": "2027-04-19",
    "weekday": "Mon",
    "occasion": "Mahavir Jayanti",
    "kind": "Gazetted holiday",
    "idea": "A short greeting; ahimsa and simplicity themes fit."
  },
  {
    "date": "2027-05-09",
    "weekday": "Sun",
    "occasion": "Mother's Day",
    "kind": "Observance",
    "idea": "Second Sunday of May. Gifting, food and family brands; schedule the gift-guide post a week ahead."
  },
  {
    "date": "2027-05-09",
    "weekday": "Sun",
    "occasion": "Rabindranath Tagore Jayanti",
    "kind": "Restricted holiday",
    "idea": "Important for Bengali audiences. A line from Tagore with your brand voice kept quiet."
  },
  {
    "date": "2027-05-17",
    "weekday": "Mon",
    "occasion": "Id-ul-Zuha (Bakrid, subject to moon sighting)",
    "kind": "Gazetted holiday",
    "idea": "Greeting on the day. The date can move by a day, so keep a draft ready for both."
  },
  {
    "date": "2027-05-20",
    "weekday": "Thu",
    "occasion": "Buddha Purnima",
    "kind": "Gazetted holiday",
    "idea": "A calm, respectful greeting."
  },
  {
    "date": "2027-06-16",
    "weekday": "Wed",
    "occasion": "Muharram (subject to moon sighting)",
    "kind": "Gazetted holiday",
    "idea": "A day of mourning for many. No celebratory or sales posts."
  },
  {
    "date": "2027-06-20",
    "weekday": "Sun",
    "occasion": "Father's Day",
    "kind": "Observance",
    "idea": "Third Sunday of June. Gifting and family content; team members sharing a photo with their fathers works if they want to."
  },
  {
    "date": "2027-06-21",
    "weekday": "Mon",
    "occasion": "International Day of Yoga",
    "kind": "Fixed-date observance",
    "idea": "Wellness, fitness and food brands. A short morning video does better than a poster."
  },
  {
    "date": "2027-07-05",
    "weekday": "Mon",
    "occasion": "Rath Yatra",
    "kind": "Restricted holiday",
    "idea": "Important in Odisha. A greeting with festival imagery for audiences there."
  },
  {
    "date": "2027-08-15",
    "weekday": "Sun",
    "occasion": "Independence Day",
    "kind": "Gazetted holiday",
    "idea": "Made-in-India stories, your team, your customers. Many brands run a sale; announce it a few days before."
  },
  {
    "date": "2027-08-15",
    "weekday": "Sun",
    "occasion": "Milad-un-Nabi (subject to moon sighting)",
    "kind": "Gazetted holiday",
    "idea": "Falls on Independence Day in 2027. A separate, respectful greeting if your audience observes it."
  },
  {
    "date": "2027-08-15",
    "weekday": "Sun",
    "occasion": "Parsi New Year (Navroz)",
    "kind": "Restricted holiday",
    "idea": "Also on 15 August in 2027. A greeting for Parsi audiences, mostly in Mumbai and Gujarat."
  },
  {
    "date": "2027-08-17",
    "weekday": "Tue",
    "occasion": "Raksha Bandhan",
    "kind": "Restricted holiday",
    "idea": "Sibling gifting for retail, sweets and D2C brands. Start teasers 7-10 days ahead."
  },
  {
    "date": "2027-08-25",
    "weekday": "Wed",
    "occasion": "Janmashtami",
    "kind": "Gazetted holiday",
    "idea": "Festival imagery and short video. Dahi handi content works for Maharashtra audiences."
  },
  {
    "date": "2027-09-04",
    "weekday": "Sat",
    "occasion": "Ganesh Chaturthi",
    "kind": "Restricted holiday",
    "idea": "Ten days of celebration in Maharashtra and Karnataka. A series across the festival works better than one post."
  },
  {
    "date": "2027-09-05",
    "weekday": "Sun",
    "occasion": "Teachers' Day",
    "kind": "Fixed-date observance",
    "idea": "Education and edtech brands; thank-you posts from your team to their teachers."
  },
  {
    "date": "2027-09-12",
    "weekday": "Sun",
    "occasion": "Onam (Thiru Onam)",
    "kind": "Restricted holiday",
    "idea": "Kerala audiences. Sadya and pookalam imagery; greeting in Malayalam if you can."
  },
  {
    "date": "2027-10-02",
    "weekday": "Sat",
    "occasion": "Gandhi Jayanti",
    "kind": "Gazetted holiday",
    "idea": "A quote or value from Gandhi tied to how your business works. Avoid discount-led posts on this day."
  },
  {
    "date": "2027-10-06",
    "weekday": "Wed",
    "occasion": "Durga Puja: Maha Saptami (Ashtami 7 Oct, Navami 8 Oct)",
    "kind": "Restricted holiday",
    "idea": "Bengal and the east. A short series across Saptami, Ashtami and Navami; Navratri runs in the north at the same time."
  },
  {
    "date": "2027-10-09",
    "weekday": "Sat",
    "occasion": "Dussehra (Vijaya Dashami)",
    "kind": "Gazetted holiday",
    "idea": "Good-over-evil framing: a problem your product fixes."
  },
  {
    "date": "2027-10-15",
    "weekday": "Fri",
    "occasion": "Maharishi Valmiki Jayanti",
    "kind": "Restricted holiday",
    "idea": "Regional audiences in North India. A short greeting is enough."
  },
  {
    "date": "2027-10-18",
    "weekday": "Mon",
    "occasion": "Karwa Chauth",
    "kind": "Restricted holiday",
    "idea": "Gifting, fashion, beauty and food brands. Schedule the post for the morning; the fast ends at moonrise."
  },
  {
    "date": "2027-10-28",
    "weekday": "Thu",
    "occasion": "Naraka Chaturdasi (Chhoti Diwali)",
    "kind": "Restricted holiday",
    "idea": "Diwali eve. Some states observe the Diwali holiday on this day, so check where your audience is."
  },
  {
    "date": "2027-10-29",
    "weekday": "Fri",
    "occasion": "Diwali",
    "kind": "Gazetted holiday",
    "idea": "Your biggest greeting of the year. Schedule the sale teaser 7-10 days out and the greeting for the morning of the day."
  },
  {
    "date": "2027-10-30",
    "weekday": "Sat",
    "occasion": "Govardhan Puja",
    "kind": "Restricted holiday",
    "idea": "Follow-up greeting; also a natural day to thank customers after Diwali."
  },
  {
    "date": "2027-10-31",
    "weekday": "Sun",
    "occasion": "Bhai Dooj",
    "kind": "Restricted holiday",
    "idea": "Sibling-gifting angle for retail and D2C brands."
  },
  {
    "date": "2027-11-04",
    "weekday": "Thu",
    "occasion": "Chhath Puja",
    "kind": "Restricted holiday",
    "idea": "Important in Bihar, Jharkhand and eastern UP. Localise if you have audiences there."
  },
  {
    "date": "2027-11-14",
    "weekday": "Sun",
    "occasion": "Guru Nanak Jayanti",
    "kind": "Gazetted holiday",
    "idea": "A respectful greeting. Keep product promotion out of it."
  },
  {
    "date": "2027-11-14",
    "weekday": "Sun",
    "occasion": "Children's Day",
    "kind": "Fixed-date observance",
    "idea": "Falls on Guru Nanak Jayanti in 2027, so keep the two posts separate and gentle."
  },
  {
    "date": "2027-11-24",
    "weekday": "Wed",
    "occasion": "Guru Teg Bahadur's Martyrdom Day",
    "kind": "Restricted holiday",
    "idea": "A day of remembrance for Sikh audiences. No promotions."
  },
  {
    "date": "2027-12-24",
    "weekday": "Fri",
    "occasion": "Christmas Eve",
    "kind": "Restricted holiday",
    "idea": "Gift-guide and last-order-date posts for delivery businesses."
  },
  {
    "date": "2027-12-25",
    "weekday": "Sat",
    "occasion": "Christmas",
    "kind": "Gazetted holiday",
    "idea": "Greeting plus a year-end offer if you run one."
  },
  {
    "date": "2027-12-31",
    "weekday": "Fri",
    "occasion": "New Year's Eve",
    "kind": "Fixed-date observance",
    "idea": "Year-in-review carousel: numbers, launches, thank-yous."
  }
];
