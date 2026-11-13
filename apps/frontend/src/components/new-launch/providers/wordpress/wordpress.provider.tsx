'use client';

import { FC } from 'react';
import {
  PostComment,
  withProvider,
} from '@hookpost/frontend/components/new-launch/providers/high.order.provider';
import { Input } from '@hookpost/react/form/input';
import { Select } from '@hookpost/react/form/select';
import { useSettings } from '@hookpost/frontend/components/launches/helpers/use.values';
import { WordpressPostType } from '@hookpost/frontend/components/new-launch/providers/wordpress/wordpress.post.type';
import { WordpressTerms } from '@hookpost/frontend/components/new-launch/providers/wordpress/wordpress.terms';
import { MediaComponent } from '@hookpost/frontend/components/media/media.component';
import { WordpressDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/wordpress.dto';

const WordpressSettings: FC = () => {
  const form = useSettings();
  return (
    <>
      <Input label="Title" {...form.register('title')} />
      {/* "posts" unless the user picks another type: an empty pick used to
          reach WordPress as POST /wp/v2/ and fail only at publish time. */}
      <WordpressPostType {...form.register('type', { value: 'posts' })} />
      <Select label="Status" {...form.register('status', { value: 'publish' })}>
        <option value="publish">Publish</option>
        <option value="draft">Draft</option>
        <option value="pending">Pending</option>
        <option value="private">Private</option>
      </Select>
      <WordpressTerms
        label="Categories"
        func="categoriesList"
        {...form.register('categories')}
      />
      <WordpressTerms
        label="WordPress Tags"
        func="tagsList"
        {...form.register('tags')}
      />
      {/* WordPress only takes an image as the featured image. */}
      <MediaComponent
        type="image"
        label="Cover picture"
        description="Add a cover picture"
        {...form.register('main_image')}
      />
    </>
  );
};
export default withProvider({
  // The WordPress provider has no comment(): without this the editor accepted
  // comments for WordPress and they were dropped at publish time.
  comments: false,
  postComment: PostComment.COMMENT,
  minimumCharacters: [],
  SettingsComponent: WordpressSettings,
  CustomPreviewComponent: undefined, // WordpressPreview,
  dto: WordpressDto,
  maximumCharacters: 100000,
});
