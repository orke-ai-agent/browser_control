# Universal Action API

This document is for external agents or local apps that want to ask the browser agent to perform actions, optionally with attached media.

## Purpose

The public action layer is intentionally simple:

- external clients send a goal
- external clients may attach one or more media files
- the orchestrator stores the media on the thread
- the planner only sees abstract media references such as `first_image` or `first_video`
- the executor handles the real upload mechanics later

That means the planner can think in terms like:

- "take the first video and upload it to Facebook"
- "attach the first image to the post composer"

It should not think about file paths, clipboard plumbing, multipart uploads, or local storage.

## Endpoints

### `POST /api/actions`

Universal action entrypoint.

Use it when:

- you want to start a new action thread
- you want to continue an existing thread
- you want to attach media with or without a prompt

Supported body formats:

- `application/json`
- `multipart/form-data`

Accepted fields:

- `prompt` or `text`
  The user instruction for the browser agent.
- `threadId`
  Optional. Continue an existing thread.
- `newThread`
  Optional boolean. Force a new thread even if `threadId` is present.
- `media`
  Zero or more media items.

Success response:

```json
{
  "thread": {
    "id": "mnabc123-xyz",
    "title": "Post first video to Facebook",
    "status": "running"
  },
  "media": [
    {
      "id": "mnmedia-123",
      "threadId": "mnabc123-xyz",
      "fileName": "clip.mp4",
      "mimeType": "video/mp4",
      "kind": "video",
      "size": 1234567,
      "source": "api_actions",
      "createdAt": "2026-04-08T10:00:00.000Z",
      "url": "/api/media/mnmedia-123"
    }
  ]
}
```

### `POST /api/threads`

Create a brand new thread with a prompt, media, or both.

### `POST /api/threads/:id/messages`

Append a prompt, media, or both to an existing thread.

### `GET /api/threads/:id`

Return full thread state including messages, block steps, and message metadata.

Media attachments are exposed in message metadata and thread metadata, so the UI can render them.

### `GET /api/media/:id`

Returns the stored media file bytes for previews.

The local UI uses this route to render attached images or files in thread history.

## JSON format

Use JSON when your caller already has base64, local paths, or remote URLs.

Example:

```json
{
  "prompt": "Post the first video to Facebook with caption hello world",
  "newThread": true,
  "media": [
    {
      "fileName": "clip.mp4",
      "mimeType": "video/mp4",
      "path": "/absolute/path/to/clip.mp4"
    },
    {
      "fileName": "cover.jpg",
      "mimeType": "image/jpeg",
      "base64": "..."
    }
  ]
}
```

Supported JSON media sources:

- `path`
- `base64`
- `url`

## Multipart format

Use multipart when your caller already has file uploads in memory or on disk.

Example:

```bash
curl -X POST http://127.0.0.1:2112/api/actions \
  -F 'prompt=Upload the first image to Facebook and publish it' \
  -F 'newThread=true' \
  -F 'media=@/absolute/path/to/photo.jpg'
```

Multiple files:

```bash
curl -X POST http://127.0.0.1:2112/api/actions \
  -F 'threadId=mnabc123-xyz' \
  -F 'text=Use the first video for the next upload flow' \
  -F 'media=@/absolute/path/to/clip.mp4' \
  -F 'media=@/absolute/path/to/poster.png'
```

## Telegram integration

Telegram uses the same action controller internally.

Current behavior:

- text messages become action prompts
- photo, video, and document attachments are ingested as thread media
- caption text is treated as the prompt when present
- `🆕 New Thread` and `/new` reset the active thread for the next message
- assistant block updates include emoji-based step summaries
- when a block actually uses media, the bot can send media previews back into chat

## Planner abstraction

Attached media is exposed to the planner as abstract refs:

- `first_media`
- `first_image`
- `first_video`
- `all_media`
- `all_images`
- `all_videos`
- `media:<id>`

The planner can choose one of these refs with the `upload_media` action:

```json
{
  "type": "upload_media",
  "mediaRef": "first_video",
  "inputHint": "upload video",
  "label": "Upload first video"
}
```

The executor resolves that reference into real stored files and handles the upload target under the hood.

## UI and thread rendering

Media is surfaced in two places:

- user messages show attached media inline
- action rows show which media a step actually used

That keeps the thread readable without forcing the planner to reason about storage details.

## Local-only assumptions

There is intentionally no auth yet.

This API is meant for localhost or trusted local-network experiments for now.
