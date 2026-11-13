#!/usr/bin/env node
/**
 * scripts/cleanup-expired-media.js
 *
 * Media Retention Policy & Automated Cleanup for Hookpost
 *
 * Policy Rules (Benchmark aligned with Buffer, Later, Hootsuite):
 * 1. Post Metadata & Analytics: Stored FOREVER in PostgreSQL (releaseURL, captions, metrics).
 * 2. Thumbnails & Previews: Stored LONG-TERM (keeps history/calendar visually functional).
 * 3. Heavy Raw Videos (.mp4, .mov): Ephemeral — Purged from Cloudflare R2 after 7 days post-publish.
 *    (Social networks like Instagram, YouTube, TikTok already store and transcode on their CDN).
 *
 * Usage:
 *   node scripts/cleanup-expired-media.js [--days 7] [--dry-run]
 */

const path = require("path");
const fs = require("fs");

// Load .env as single source of truth
const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const { PrismaClient } = require("@prisma/client");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");


const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const daysIdx = args.indexOf("--days");
const RETENTION_DAYS = daysIdx !== -1 && args[daysIdx + 1] ? parseInt(args[daysIdx + 1], 10) : 7;

const prisma = new PrismaClient();

// Setup Storage client (supports Cloudflare R2, Google Cloud Storage GCS, AWS S3, Local)
const storageProvider = (process.env.STORAGE_PROVIDER || "cloudflare").toLowerCase();
const isGCS = storageProvider === "google" || storageProvider === "gcs";
const isCloudflare = storageProvider === "cloudflare";
const isS3 = storageProvider === "s3" || storageProvider === "aws";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const accessKey = process.env.CLOUDFLARE_ACCESS_KEY || process.env.GCS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
const secretKey = process.env.CLOUDFLARE_SECRET_ACCESS_KEY || process.env.GCS_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY;
const bucketName = process.env.CLOUDFLARE_BUCKETNAME || process.env.GCS_BUCKET_NAME || process.env.AWS_BUCKET_NAME;
const uploadDir = process.env.UPLOAD_DIRECTORY || "/uploads";
// Where the bucket's files are served (media.hookstep.in). The bucket also
// holds Tablamigo's photos, so a key is only deleted when the URL really is a
// file of ours: a post can carry an external link whose last segment could
// match someone else's object.
const bucketUrl = (process.env.CLOUDFLARE_BUCKET_URL || "").replace(/\/+$/, "");

/**
 * Providers that can publish a file as a link to our URL instead of uploading
 * it: Discord posts a file over its upload limit that way, so the published
 * message keeps pointing at the file for as long as it exists.
 */
const LINKED_MEDIA_PROVIDERS = ["discord"];

/**
 * Posts that still need this file:
 * - live posts not yet published. A failed post counts: it shares the file
 *   with the posts of its group that did publish, and without the file it
 *   can never be retried.
 * - published posts of a provider that may have linked to it (see
 *   LINKED_MEDIA_PROVIDERS), deleted ones included: deleting a post in
 *   Hookpost leaves the message on the platform.
 */
function pendingPostsUsing(fileUrl) {
  return {
    image: { contains: fileUrl },
    OR: [
      {
        deletedAt: null,
        // REMINDER_SENT: "Remind me to post" sent the file's link and the
        // user has not posted it from the app yet
        state: { in: ["QUEUE", "DRAFT", "ERROR", "REMINDER_SENT"] },
      },
      {
        state: "PUBLISHED",
        integration: { providerIdentifier: { in: LINKED_MEDIA_PROVIDERS } },
      },
    ],
  };
}

/** True when this URL is one of our stored files (see bucketUrl). */
function isOurUrl(fileUrlOrPath, base = bucketUrl) {
  if (!fileUrlOrPath) return false;
  if (!base) return true; // not R2 or not configured: unchanged behaviour
  return fileUrlOrPath.startsWith(`${base}/`);
}

/**
 * Published posts older than the cutoff. Deleted posts included: deleting a
 * post (or the account that owns it) only hides it, so its video was never
 * purged and stayed reachable at its URL.
 */
function expiredPublishedPostsWhere(cutoffDate) {
  return {
    // POSTED_MANUALLY: posted by the user from a reminder, live like any
    // published post, so its file goes after the same 7 days
    state: { in: ["PUBLISHED", "POSTED_MANUALLY"] },
    publishDate: { lte: cutoffDate },
  };
}

let s3Client = null;
let gcsClient = null;

if (isCloudflare && accountId && accessKey && secretKey) {
  s3Client = new S3Client({
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: process.env.CLOUDFLARE_REGION || "auto",
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
} else if (isGCS) {
  // GCS supports both S3-interoperability API (HMAC) and native @google-cloud/storage
  if (accessKey && secretKey) {
    s3Client = new S3Client({
      endpoint: process.env.GCS_ENDPOINT || "https://storage.googleapis.com",
      region: process.env.GCS_REGION || "auto",
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
    });
  } else {
    try {
      const { Storage } = require("@google-cloud/storage");
      gcsClient = new Storage();
    } catch {
      // Will fall back to S3 if keys are supplied
    }
  }
} else if (isS3 && accessKey && secretKey) {
  s3Client = new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
  });
}

async function deleteFromStorage(fileUrlOrPath) {
  if (!fileUrlOrPath) return false;
  const fileName = fileUrlOrPath.split("/").pop();
  if (!fileName) return false;

  if (s3Client && bucketName) {
    if (isCloudflare && !isOurUrl(fileUrlOrPath)) {
      console.log(`  [SKIP] Not a file in ${bucketName}: ${fileUrlOrPath}`);
      return false;
    }
    if (isDryRun) {
      console.log(`  [DRY-RUN] Would delete from storage (${storageProvider} bucket ${bucketName}): ${fileName}`);
      return true;
    }
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: fileName }));
      console.log(`  [DELETED] Object: ${fileName} from ${bucketName}`);
      return true;
    } catch (err) {
      console.error(`  [ERROR] Failed to delete ${fileName} from ${bucketName}:`, err.message);
      return false;
    }
  } else if (gcsClient && bucketName) {
    if (isDryRun) {
      console.log(`  [DRY-RUN] Would delete GCS object: ${fileName} from ${bucketName}`);
      return true;
    }
    try {
      await gcsClient.bucket(bucketName).file(fileName).delete();
      console.log(`  [DELETED] GCS Object: ${fileName} from ${bucketName}`);
      return true;
    } catch (err) {
      console.error(`  [ERROR] Failed to delete ${fileName} from GCS bucket ${bucketName}:`, err.message);
      return false;
    }
  } else if (storageProvider === "local") {
    const localPath = path.isAbsolute(fileUrlOrPath) ? fileUrlOrPath : path.join(uploadDir, fileName);
    if (isDryRun) {
      console.log(`  [DRY-RUN] Would unlink local file: ${localPath}`);
      return true;
    }
    try {
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
        console.log(`  [DELETED] Local file: ${localPath}`);
        return true;
      }
    } catch (err) {
      console.error(`  [ERROR] Failed to unlink ${localPath}:`, err.message);
      return false;
    }
  }
  return false;
}

function isVideoFile(filePath) {
  if (!filePath) return false;
  return /\.(mp4|mov|m4v|avi|webm|mkv)$/i.test(filePath);
}

async function main() {
  const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 86400 * 1000);
  console.log("==========================================================");
  console.log(`  Hookpost Media Retention Cleanup Engine`);
  console.log(`  Mode: ${isDryRun ? "DRY-RUN (Simulated)" : "LIVE PURGE"}`);
  console.log(`  Retention Window: ${RETENTION_DAYS} Days`);
  console.log(`  Cutoff Date: ${cutoffDate.toISOString()}`);
  console.log(`  Storage Provider: ${storageProvider}`);
  console.log("==========================================================\n");

  // 1. Find all PUBLISHED posts older than cutoffDate
  const publishedPosts = await prisma.post.findMany({
    where: expiredPublishedPostsWhere(cutoffDate),
    select: {
      id: true,
      publishDate: true,
      image: true,
      releaseURL: true,
      organizationId: true,
    },
  });

  console.log(`Found ${publishedPosts.length} published posts older than ${RETENTION_DAYS} days.`);
  let totalVideosPurged = 0;

  for (const post of publishedPosts) {
    if (!post.image) continue;

    let mediaItems = [];
    try {
      mediaItems = typeof post.image === "string" ? JSON.parse(post.image) : post.image;
    } catch {
      continue;
    }

    if (!Array.isArray(mediaItems)) continue;

    let modified = false;
    for (const item of mediaItems) {
      const videoPath = item.path || item.url;
      if (videoPath && isVideoFile(videoPath)) {
        // Purged on an earlier night: the object is gone, only the library entry may still need hiding.
        if (!item.originalPurged) {
          // The same library video can be attached to a post that has not gone
          // out yet; deleting it would make that post fail.
          const stillNeeded = await prisma.post.count({
            where: pendingPostsUsing(videoPath),
          });
          if (stillNeeded) {
            console.log(`Post ${post.id}: keeping ${videoPath}, ${stillNeeded} scheduled, draft, failed or link-published post(s) still use it`);
            continue;
          }
          console.log(`Post ${post.id} (${post.publishDate.toISOString()}): Purging raw video ${videoPath}`);
          const ok = await deleteFromStorage(videoPath);
          if (!ok) continue;
          totalVideosPurged++;
          // Retain thumbnail, remove raw video pointer to save space
          item.originalPurged = true;
          item.purgedAt = new Date().toISOString();
          modified = true;
        }
        // Hide the same file in the Media Library, so nobody picks a video that no longer exists.
        if (!isDryRun) {
          const hidden = await prisma.media.updateMany({
            where: { organizationId: post.organizationId, path: videoPath, deletedAt: null },
            data: { deletedAt: new Date() },
          });
          if (hidden.count) console.log(`  [LIBRARY] Hid ${hidden.count} Media Library item(s) for ${videoPath}`);
        }
      }
    }

    if (modified && !isDryRun) {
      await prisma.post.update({
        where: { id: post.id },
        data: { image: JSON.stringify(mediaItems) },
      });
    }
  }

  console.log("\n----------------------------------------------------------");
  console.log(`Cleanup Summary:`);
  console.log(`Total Expired Posts Inspected: ${publishedPosts.length}`);
  console.log(`Total Heavy Videos Purged: ${totalVideosPurged}`);
  console.log(`Metadata & releaseURLs Preserved: 100%`);
  console.log(`Thumbnails Preserved for UI: 100%`);
  console.log("----------------------------------------------------------");
}

module.exports = { expiredPublishedPostsWhere, isOurUrl, pendingPostsUsing };

if (require.main === module) {
  main()
    .catch((e) => {
      console.error("Cleanup error:", e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
