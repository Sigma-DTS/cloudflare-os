import type { GadgetSharingInfo } from '@gadgets/workshop-shared/api';

/** Whether an independent gadget grant admits this viewer, honoring the workspace's data policy. */
export const canViewSharedGadget = (
    sharing: GadgetSharingInfo | undefined, profileId: string,
    ownerInvitesOnly: boolean, ownerProfileId: string): boolean => {
  if (!sharing) return false;
  if (!ownerInvitesOnly && sharing.allUsersCanView) return true;
  return sharing.viewers.some(viewer => viewer.profile.id === profileId &&
      viewer.addedBy.some(edge => edge.type === 'user' &&
          (!ownerInvitesOnly || edge.sharer === ownerProfileId)));
};
