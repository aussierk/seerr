---
title: Request Conflicts
description: What happens when users request the same title with different settings, and how to resolve it.
sidebar_position: 5
---

# Request Conflicts

More than one user can request the same title. Their requests conflict when they target the **same Radarr or Sonarr server** but ask for a different **quality profile**, **root folder** or, for series, **language profile**. For series, the requests also have to share at least one season. Requests on different servers, or with identical settings, never conflict.

A request that conflicts with another user's active request is created as usual, but it is **never approved automatically**, even for users with auto-approve. It stays pending until someone with the `Manage Requests` permission decides which settings win. The normal **Approve** button is replaced by **Resolve Conflict** for these requests.

## Resolving a conflict

Conflicting pending requests are marked with a **Conflict** badge, in the request list and in the title's **Manage** panel.

In the **Manage** panel, select **Resolve Conflict** on a request to see its settings next to those of every request it conflicts with. Selecting **Use These Settings** will:

- approve that request,
- give the other pending requests its quality profile, root folder and language profile (they stay pending, with their own owner and tags), and
- if the title is already in Radarr or Sonarr and **Update Existing Items** is enabled in the [general settings](/using-seerr/settings/general), update the quality profile, language profile and root folder of the existing item to match.

Requests that were already approved or completed keep the settings they were sent with.

:::warning
Changing the root folder of an item that is already in Radarr or Sonarr **moves its files**. If the update fails, Seerr logs a warning and carries on with the request.
:::

Only settings that were chosen explicitly are applied. A request that simply takes the server defaults never changes an existing item.
