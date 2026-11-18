---
title: Requests From Multiple Users
description: What happens when several users request the same title.
sidebar_position: 5
---

# Requests From Multiple Users

Several users can request the same movie or series, even if it has already been requested by someone else or is already available. Seerr only stops you from requesting something **you** have already requested.

## Movies

You can have one request per movie (one regular and one 4K). If your earlier request was declined, or the movie has since been removed, you can request it again.

## Series

Seasons you have already requested are left out of a new request. Seasons that other users have requested, or that are already available, can still be requested.

## Approval

Requests are approved as usual for users with auto-approve. If a request asks for different settings than another user's request for the same title, such as a different quality profile or root folder, it waits for a manager to decide. See [Request Conflicts](/using-seerr/request-conflicts).

## Titles Already in Radarr/Sonarr

If the title is already in Radarr or Sonarr, Seerr adds the new requester's tags to it. If **Tag Requests** is enabled for the server, this includes a tag for the requester. Tags are only ever added, so everyone who requests a title ends up tagged on it. See [Services](/using-seerr/settings/services#tag-requests-optional).

A request can also change the quality profile, root folder or language profile of the existing item, but only if **Update Existing Items** is enabled in the [general settings](/using-seerr/settings/general#update-existing-items), a manager approved the request, and the setting differs from the server defaults.

:::warning
Changing the root folder of an item that is already in Radarr or Sonarr **moves its files**.
:::

## Removing Media

If you remove media from Radarr or Sonarr in the **Manage** panel while pending, approved or completed requests depend on it, Seerr asks you to confirm first.
