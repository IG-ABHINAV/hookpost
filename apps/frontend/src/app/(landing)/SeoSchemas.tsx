import React from 'react';
import { FAQ_DATA } from './LandingFaq';
import { heroDemoVideoObject } from './hero-demo.schema';

// Homepage-only structured data: the FAQ and the demo video under the hero
// (hero-demo.schema.ts). The product entity (#app, with its offers and
// featureList) is declared once in the landing layout for every page; this
// used to add a second SoftwareApplication here, plus a breadcrumb of
// Home > Alternatives > Compare Tools whose last item was not this page.
export default function SeoSchemas() {
  const homepageGraph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        '@id': 'https://hookpost.hookstep.in/#faq',
        mainEntity: FAQ_DATA.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: {
            '@type': 'Answer',
            text: item.a,
          },
        })),
      },
      heroDemoVideoObject(),
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(homepageGraph) }}
    />
  );
}
