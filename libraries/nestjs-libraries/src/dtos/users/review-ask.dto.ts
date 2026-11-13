import { IsIn, ValidateIf } from 'class-validator';
import {
  REVIEW_ASK_TARGETS,
  ReviewAskTarget,
} from '@hookpost/nestjs-libraries/database/prisma/review-ask/review.ask.policy';

/** What happened to the review card (POST /user/review-ask). */
export class ReviewAskDto {
  @IsIn(['shown', 'dismissed', 'clicked'])
  action: 'shown' | 'dismissed' | 'clicked';

  /** Which review page was opened; required with `clicked`. */
  @ValidateIf((o) => o.action === 'clicked')
  @IsIn(REVIEW_ASK_TARGETS)
  target?: ReviewAskTarget;
}
