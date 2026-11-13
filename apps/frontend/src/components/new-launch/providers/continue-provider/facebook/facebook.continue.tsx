'use client';

import { withContinueProvider } from '../with-continue-provider';
import { MetaNoPagesHelp } from '../meta/meta.no.pages.help';
import { metaPickerHowTo } from '../meta/meta.picker.howto';

interface FacebookItem {
  id: string;
  username: string;
  name: string;
  picture: {
    data: {
      url: string;
    };
  };
}

export const FacebookContinue = withContinueProvider<FacebookItem, string>({
  endpoint: 'pages',
  swrKey: 'load-facebook-pages',
  titleKey: 'select_page',
  titleDefault: 'Select Page:',
  emptyStateMessages: [
    {
      key: 'facebook_no_pages',
      text: 'This Facebook account has no Pages Hookpost can post to. Hookpost posts to Facebook Pages, not to personal profiles.',
    },
    {
      key: 'facebook_no_pages_next',
      text: 'Create a Page (it takes a minute), then add Facebook again. Already have a Page? Add Facebook again and select that Page when Facebook asks which Pages to share.',
    },
    {
      key: 'facebook_no_pages_instagram',
      text: 'Instagram through Facebook needs the same thing: a professional Instagram account (Business or Creator) linked to a Facebook Page.',
    },
  ],
  EmptyStateLead: MetaNoPagesHelp,
  PickerHelp: metaPickerHowTo('facebook'),
  emptyStateAction: {
    key: 'create_a_facebook_page',
    text: 'Create a Facebook Page',
    url: 'https://www.facebook.com/pages/create',
  },
  getItemId: (item) => item.id,
  getSelectionValue: (item) => item.id,
  transformSaveData: (selection) => ({ page: selection }),
  isSelected: (item, selection) => selection === item.id,
  renderItem: (item) => (
    <>
      <div>
        <img className="w-full" src={item.picture.data.url} alt="profile" />
      </div>
      <div>{item.name}</div>
    </>
  ),
});
