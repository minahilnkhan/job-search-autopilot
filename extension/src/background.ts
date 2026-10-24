// Clicking the toolbar icon opens the side panel. It stays open while you
// work in the page, unlike a popup.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
