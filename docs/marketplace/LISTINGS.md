# api.market listings: copy, plans and setup order

Store `hookstep` (seller display name "Hookstep"; the Social product is https://api.market/seller/hookstep/products/hookpost). The gateway went live on 25 Oct 2026 (main cb9b0c78b, deploy run 40191792628): all four products answer at `https://hookpost.hookstep.in/api/mkt/v1/<product>` behind `x-hookpost-gateway`. This page is what goes into api.market; the plan numbers come from `libraries/nestjs-libraries/src/marketplace/marketplace.plans.ts` and must stay in step with it.

The secrets are not here. They are in `~/.config/apimarket/hookpost-gateway.env` on the owner's Mac (mode 600): `SECRET_<PRODUCT>` for each Source and a ready-to-paste `PLAN_HEADER_<PRODUCT>_<PLAN>` JSON for each plan. The server `.env` holds the same secrets and only SHA-256 hashes of the plan tokens.

## Reviewer feedback (same on all three ACTION_REQUIRED listings, 23 Oct)

> Your product only has a paid $19 plan, and this listing offers the same API as your other three listings. Please add a free plan with API limit type Hard, which buyers get as a 7-day trial, and keep one listing for this API.

How this answers it: every listing now has its own Source with its own endpoints (no shared `/public/v1`), and every listing has a 7-day "Free trial" plan with a hard limit. The fourth duplicate listing ("Social Media MCP Server", `/mcp-social-server`) stays in Draft and is not resubmitted, because api.market already gives every product an MCP server.

## Setup order (per product)

1. **Source.** Created on 25 Oct from the spec in this folder: "Hookpost Social Scheduler API", "LinkedIn Carousel & Post API", "X Thread API" (auth still None). Still to import: `post-validator.openapi.json` and `probe.openapi.json` (base URL of the product being probed). Then Source > Edit Authentication > API Key, header name `x-hookpost-gateway`, value `SECRET_<PRODUCT>`.
2. **Probe (optional).** The spoofing risk this step checked for is resolved: api.market confirmed in writing (support, Shashank, 26 Oct 2026) that it always overwrites `x-magicapi-plan` and `x-magicapi-user` before forwarding, so a buyer cannot act as another subscriber or pick a plan. The probe Source is still useful for billing questions (`?status=201`, `?bill=5`) and `client_ip`; see README "Before launch".
3. **Plans.** For each plan below: Source = the product's new Source, billing unit "Per call", included calls = credits, "Stop the calls" when they run out, every endpoint, Public, and in "Advanced: custom headers" paste that plan's `PLAN_HEADER_...` line value (not for Social: its plans are told apart by their titles, "Free" (api.market's name for a free plan; "Free trial" is still accepted during the rename), "Standard", "Pro", plus api.market's private review plan "Tester" (Pro limits), through `x-magicapi-plan`, so they keep `{}`). Delete or make private the old plans that point at the old `/public/v1` Sources.
4. **Product settings.** Title, subtitle, description, category below. Save.
5. **Resubmit** for review.

Credits are reported per call through `X-Magicapi-Billing: API=N;` (api.market's custom usage); every description says what each call costs, as api.market asks.

---

## 1. Hookpost Social Scheduler API (`/hookpost`, now IN_REVIEW on the old Source)

- **Title:** Hookpost Social Scheduler API
- **Subtitle:** Schedule one post to LinkedIn, X, Threads, Facebook, Instagram, YouTube, Pinterest, Discord and Slack in one call. Accounts connect with a sign-in link.
- **Category:** Business APIs
- **Source:** Hookpost Social Scheduler API (`/api/mkt/v1/social`)

| Plan | Type | Price | Included calls (credits) | Limit | Header line |
|---|---|---|---|---|---|
| Free | Free trial, 7 days | $0 | 10 | Hard | `{}` (by plan title) |
| Standard | Monthly | $19 | 500 | Hard | `{}` (by plan title) |
| Pro | Monthly | $39 | 1,200 | Hard | `{}` (by plan title) |

The Free plan is for testing, not free use (owner, 26 Oct 2026): 10 credits and 1 channel, 7 days. It was 100 credits, 2 channels and 250 MB until then; a subscriber whose 28-day window began before the change keeps those to its end (`PRIOR_PLAN_LIMITS`). The private "Tester" plan (api.market's review team) stays at Pro limits. On RapidAPI the same trial is the BASIC plan: 10 Credits a month, hard limit.

**Description:**

```markdown
# Hookpost Social Scheduler API

One API call schedules a post to several social networks at once: LinkedIn, X, Threads, Facebook, Instagram, YouTube, Pinterest, Discord and Slack. You connect each account once with a sign-in link, upload media, and create posts or threads for now, a set time, or as drafts. Hookpost publishes them and reports the status of every post.

## How access works
- You call this API with your api.market key. You never need a Hookpost account or a Hookpost key, and you should never send one: any `Authorization` header is refused.
- Your first call creates a private workspace for your subscription. Nobody else can see your channels, media or posts, and you cannot see theirs.
- `GET /connect/{provider}` returns a sign-in URL for that network. Open it, sign in to your own account, and the channel appears in `GET /channels`. Treat the URL like a password: it works for one hour.
- `GET /providers` lists every network with its limits (characters, media, video rules) and needs nothing connected.

## Credits (what each call costs)
- 1 credit per channel a post goes to. A post to LinkedIn, Threads and Facebook costs 3.
- X: 2 credits per tweet (each reply in a thread is a tweet); 20 credits per tweet that contains a link. Links in X posts are refused unless you send `"link_policy": "allow"`, so you are never charged for one by surprise.
- 0 credits: reading channels, posts, slots, notifications and usage, connect links, media uploads, validation (`POST /posts/validate`), and deleting a scheduled post.
- Only successful calls are billed. `GET /usage` shows what you have used.

## Plans
- Free: 7 days, 10 credits, 1 channel, X not included, 50 MB of media. For testing the API before you subscribe.
- Standard: 500 credits a month, 5 channels, 2 GB of media.
- Pro: 1,200 credits a month, 20 channels, 10 GB of media.
- Posts can be scheduled up to 7 days ahead on the trial and 35 days ahead on paid plans. YouTube: 1 upload a day on the trial, 3 on paid plans.

## Endpoints
- `GET /providers`, `GET /connect/{provider}`, `GET /channels`, `DELETE /channels/{id}`
- `POST /media` (file), `POST /media/from-url` (images up to 10 MB, videos up to 200 MB; send videos over 95 MB by URL)
- `POST /posts`, `POST /posts/validate`, `GET /posts`, `GET /posts/{id}`, `DELETE /posts/{id}`
- `GET /slots/{channel_id}` (next open time), `GET /notifications`, `GET /usage`

## Good to know
- LinkedIn posts go to personal profiles. Company Pages are not supported yet.
- Each subscriber is limited to 2 write calls and 10 read calls a second.
- Scheduled posts are accepted (and billed) when you create them. Delete one before it publishes if you change your mind.

Hookpost is built by Hookstep. Support: support@hookstep.in
```

## 2. LinkedIn Carousel & Post API (`/linkedin-poster-api`, ACTION_REQUIRED)

- **Title:** LinkedIn Carousel & Post API
- **Subtitle:** Turn 2 to 20 images into a LinkedIn-ready PDF carousel, then publish carousels, image, video and text posts to your LinkedIn profile.
- **Category:** Business APIs
- **Source:** LinkedIn Carousel & Post API (`/api/mkt/v1/linkedin`)

| Plan | Type | Price | Included calls (credits) | Limit | Header line |
|---|---|---|---|---|---|
| Free trial | Free trial, 7 days | $0 | 50 | Hard | `PLAN_HEADER_LINKEDIN_TRIAL` |
| Creator | Monthly | $9 | 300 | Hard | `PLAN_HEADER_LINKEDIN_CREATOR` |
| Agency | Monthly | $29 | 1,500 | Hard | `PLAN_HEADER_LINKEDIN_AGENCY` |

**Description:**

```markdown
# LinkedIn Carousel & Post API

Make LinkedIn document carousels from images and publish them, with posts, to your LinkedIn profile.

## Render a carousel, no account needed
`POST /carousels/render` takes 2 to 20 images (URLs or uploaded media ids, 50 MB in total), a title and a size (`square` or `portrait`), and returns a PDF that LinkedIn shows as a swipeable carousel. The PDF link works for 7 days. Nothing has to be connected for this call.

## Publish to LinkedIn
- `GET /connect` returns a sign-in URL. Sign in to your own LinkedIn account once; treat the URL like a password, it works for one hour.
- `POST /carousels` publishes a carousel with your post text, now or at a set time.
- `POST /posts` publishes a text post, or a post with an image or a video.
- `GET /posts/{id}` reads the status; `DELETE /posts/{id}` cancels one before it publishes.

## How access works
You call this API with your api.market key only. You never need a Hookpost account or key; any `Authorization` header is refused. Your first call creates a private workspace for your subscription.

## Credits
- 1 credit: a carousel render, a carousel post, a post.
- 0 credits: connect links, channels, media uploads, status reads, deletes, `GET /usage`.
- Only successful calls are billed.

## Plans
- Free trial: 7 days, 50 credits, 1 LinkedIn profile.
- Creator: 300 credits a month, 2 profiles.
- Agency: 1,500 credits a month, 10 profiles.

## Good to know
Personal profiles only. Company Pages are not supported yet.

Built by Hookstep. Support: support@hookstep.in
```

## 3. X Thread API (`/twitter-thread-scheduler`, ACTION_REQUIRED)

- **Title:** X Thread API
- **Subtitle:** Schedule X (Twitter) threads as an array of tweets, with a cost estimate first. Links are refused unless you allow them.
- **Category:** Business APIs
- **Source:** X Thread API (`/api/mkt/v1/x`)

| Plan | Type | Price | Included calls (credits) | Limit | Header line |
|---|---|---|---|---|---|
| Free trial | Free trial, 7 days | $0 | 50 (25 tweets, no links, 5 tweets a thread) | Hard | `PLAN_HEADER_X_TRIAL` |
| Basic | Monthly | $12 | 300 | Hard | `PLAN_HEADER_X_BASIC` |
| Pro | Monthly | $35 | 1,000 | Hard | `PLAN_HEADER_X_PRO` |

**Description:**

```markdown
# X Thread API

Send a thread to X as a plain array of tweets. Check it first: the estimate counts every tweet the way X does, flags links and media problems, and tells you the price before anything is posted.

## Estimate, no account needed
`POST /threads/estimate` takes `{"tweets": [{"text": "...", "media_count": 0}], "premium": false}` and returns, per tweet, the character count against X's limit (280, or 4,000 for X Premium accounts), whether it contains a link, any errors, and the total credits.

## Publish
- `GET /connect` returns a sign-in URL. Sign in to your own X account once; treat the URL like a password, it works for one hour.
- `POST /threads` takes the tweets (up to 4 images or 1 video each), a time to publish, who can reply, and `link_policy`.
- `GET /threads/{id}` returns the status and the URL of each tweet; `DELETE /threads/{id}` cancels a thread before it publishes.

## Credits
- 2 credits per tweet. A 5-tweet thread costs 10.
- 20 credits per tweet that contains a link, because X charges more for those. Links are refused unless you send `"link_policy": "allow"`.
- 0 credits: estimates, connect links, channels, media uploads, status reads, deletes, `GET /usage`.
- Only successful calls are billed.

## Plans
- Free trial: 7 days, 50 credits (25 tweets), no links, up to 5 tweets a thread, 1 X account.
- Basic: 300 credits a month, 2 X accounts, threads up to 25 tweets.
- Pro: 1,000 credits a month, 5 X accounts.
- Every X account is limited to 50 tweets a day.

## How access works
You call this API with your api.market key only. You never need a Hookpost account or key; any `Authorization` header is refused. Your first call creates a private workspace for your subscription.

Built by Hookstep. Support: support@hookstep.in
```

## 4. Social Post Validator API (new listing, suggested slug `/social-post-validator`)

- **Title:** Social Post Validator API
- **Subtitle:** Check a social post against each network's rules before you publish: character limits counted the way each network counts, media counts, types and sizes.
- **Category:** Text Analysis
- **Source:** Social Post Validator API (`/api/mkt/v1/validate`, still to import)

| Plan | Type | Price | Included calls (credits) | Limit | Header line |
|---|---|---|---|---|---|
| Free trial | Free trial, 7 days | $0 | 200 checks | Hard | `PLAN_HEADER_VALIDATE_TRIAL` |
| Starter | Monthly | $5 | 5,000 checks | Hard | `PLAN_HEADER_VALIDATE_STARTER` |
| Scale | Monthly | $15 | 30,000 checks | Hard | `PLAN_HEADER_VALIDATE_SCALE` |

**Description:**

```markdown
# Social Post Validator API

Check a draft against the rules of each social network before you post it, so a scheduled post does not fail at publish time. Nothing to connect, nothing is posted, and no social network is called.

## What it checks
- Character limits, counted the way each network counts them (X counts emoji and some scripts as two characters and every link as 23; Threads counts bytes).
- How many images or videos each network accepts, whether a video has to be alone or needs a cover, and whether every image must have the same width and height.
- File sizes against the upload limits (10 MB an image, 200 MB a video).

## Endpoints
- `POST /check` takes `{"text": "...", "media": [{"type": "image", "bytes": 120000, "width": 1080, "height": 1350}], "platforms": ["x", "linkedin", "threads"]}` and returns pass or fail per network, with the reasons and the character count. 1 credit per check, however many networks.
- `GET /rules` returns every network's rules. 0 credits.
- `GET /usage` returns what you have used. 0 credits.

## How access works
You call this API with your api.market key only; any `Authorization` header is refused. Only successful calls are billed.

## Plans
- Free trial: 7 days, 200 checks.
- Starter: 5,000 checks a month.
- Scale: 30,000 checks a month.

Built by Hookstep. Support: support@hookstep.in
```

## 5. Social Media MCP Server API (`/mcp-social-server`, ACTION_REQUIRED)

Keep in Draft, do not resubmit. It would be the same API a fourth time, which is what the reviewer refused, and api.market already exposes every product as an MCP server at `api.market/api/mcp/{store}/{slug}`. Deleting it is the owner's call.

## Shazam Music Recognition (`/shazam-music-recognition`)

Untouched. It is publicly live (Approved).

## Profit at the worst case (marketplace.plans.spec.ts enforces it)

The worst case: every credit spent on X tweets with links ($0.20 a tweet, 20 credits, so $0.01 a credit), our own cap fully used (2x the plan's credits per 28-day window, 2.17x a month), and a 25% fee instead of api.market's "up to 20%".

| Plan | Price | We keep at 20% fee | Worst-case monthly profit |
|---|---|---|---|
| Social Standard | $19 | $15.20 | $3.38 |
| Social Pro | $39 | $31.20 | $3.16 |
| X Basic | $12 | $9.60 | $2.48 |
| X Pro | $35 | $28.00 | $4.51 |
| LinkedIn Creator / Agency | $9 / $29 | $7.20 / $23.20 | no per-call cost to us |
| Validator Starter / Scale | $5 / $15 | $4.00 / $12.00 | no per-call cost to us |

Social without X costs us almost nothing per post, so a Social Standard buyer who never posts to X leaves about $15. The X trial is the only real cost of a trial (up to $0.375 each), and all X trials together are capped at $3 a day (`MKT_TRIAL_X_DAILY_USD`). api.market pays out from $50.
