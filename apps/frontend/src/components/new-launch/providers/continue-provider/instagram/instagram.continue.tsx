'use client';

import { withContinueProvider } from '../with-continue-provider';
import { MetaNoPagesHelp } from '../meta/meta.no.pages.help';
import { metaPickerHowTo } from '../meta/meta.picker.howto';

interface InstagramItem {
  id: string;
  pageId: string;
  username: string;
  name: string;
  picture: {
    data: {
      url: string;
    };
  };
}

interface InstagramSelection {
  id: string;
  pageId: string;
}

export const InstagramContinue = withContinueProvider<
  InstagramItem,
  InstagramSelection
>({
  endpoint: 'pages',
  swrKey: 'load-instagram-pages',
  titleKey: 'select_instagram_account',
  titleDefault: 'Select Instagram Account:',
  emptyStateMessages: [
    {
      key: 'instagram_no_accounts',
      text: 'We found no Instagram professional account linked to a Facebook Page on this login. A personal Instagram account, or one not linked to a Page, does not show up here.',
    },
    {
      key: 'instagram_no_accounts_next',
      text: 'Instagram through Facebook works only with a professional Instagram account (Business or Creator) linked to a Facebook Page, and Facebook itself posts to Pages, not personal profiles. Switch your Instagram to professional, link it to a Page in the Instagram app, then add Instagram again.',
    },
  ],
  EmptyStateLead: MetaNoPagesHelp,
  PickerHelp: metaPickerHowTo('instagram'),
  emptyStateAction: {
    key: 'create_a_facebook_page',
    text: 'Create a Facebook Page',
    url: 'https://www.facebook.com/pages/create',
  },
  getItemId: (item) => item.id,
  getSelectionValue: (item) => ({ id: item.id, pageId: item.pageId }),
  transformSaveData: (selection) => selection,
  isSelected: (item, selection) => selection?.id === item.id,
  renderItem: (item) => (
    <>
      <div>
        <img
          className="w-full max-w-[156px]"
          src={item.picture.data.url}
          alt="profile"
        />
      </div>
      <div>{item.name}</div>
    </>
  ),
});
