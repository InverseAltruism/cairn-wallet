// The approval window's outer size, as background.ts asks chrome.windows.create for it. Every element with security
// weight must fit above the buttons in the page inside it, for every request type: test/approve-layout-chrome.test.mjs
// measures the page at this width and at this height less APPROVE_FRAME_PX. Width is the axis small screens can spare:
// at 460 a whole address and a short amount share one line.
export const APPROVE_WINDOW = { width: 460, height: 716 } as const;
// What the browser draws inside those bounds: measured on Linux (Chrome 145 under X without a window manager) as nothing,
// since an extension's own popup window has no location bar, and as 56 with the info bar of Chrome for Testing. Windows
// and macOS are expected to draw a title bar inside the bounds (not measured here); 56 is the largest frame seen.
export const APPROVE_FRAME_PX = 56;
