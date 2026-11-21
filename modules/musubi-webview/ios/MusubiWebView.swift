import ExpoModulesCore
import Foundation
import WebKit

@MainActor
final class MusubiAdBlockRuleStore {
  static let shared = MusubiAdBlockRuleStore()
  static let ruleListIdentifier = "musubi-adblock"
  static let rulesDidUpdateNotification = Notification.Name("MusubiAdBlockRulesDidUpdate")

  private(set) var cachedRuleList: WKContentRuleList?

  private init() {}

  func lookupOrFetchRuleList(completion: @escaping (WKContentRuleList?) -> Void) {
    if let cachedRuleList {
      completion(cachedRuleList)
      return
    }

    guard let store = WKContentRuleListStore.default() else {
      completion(nil)
      return
    }

    store.lookUpContentRuleList(forIdentifier: Self.ruleListIdentifier) { [weak self] ruleList, _ in
      Task { @MainActor in
        if let ruleList {
          self?.cachedRuleList = ruleList
        }
        completion(self?.cachedRuleList)
      }
    }
  }

  func compileRules(
    primaryJson: String,
    fallbackJson: String?,
    completion: @escaping ([String: Bool]) -> Void
  ) {
    guard let store = WKContentRuleListStore.default() else {
      completion(["compiled": false, "usedFallback": false])
      return
    }

    store.compileContentRuleList(
      forIdentifier: Self.ruleListIdentifier,
      encodedContentRuleList: primaryJson
    ) { [weak self] ruleList, _ in
      Task { @MainActor in
        if let ruleList {
          self?.cachedRuleList = ruleList
          NotificationCenter.default.post(name: Self.rulesDidUpdateNotification, object: nil)
          completion(["compiled": true, "usedFallback": false])
          return
        }

        guard let fallbackJson, !fallbackJson.isEmpty, fallbackJson != primaryJson else {
          completion(["compiled": false, "usedFallback": false])
          return
        }

        store.compileContentRuleList(
          forIdentifier: Self.ruleListIdentifier,
          encodedContentRuleList: fallbackJson
        ) { [weak self] fallbackRuleList, _ in
          Task { @MainActor in
            if let fallbackRuleList {
              self?.cachedRuleList = fallbackRuleList
              NotificationCenter.default.post(name: Self.rulesDidUpdateNotification, object: nil)
              completion(["compiled": true, "usedFallback": true])
            } else {
              completion(["compiled": false, "usedFallback": true])
            }
          }
        }
      }
    }
  }
}

public final class MusubiWebView: ExpoView, WKNavigationDelegate, WKUIDelegate {
  var url: String = ""
  var offlineHtmlPath: String?
  var adBlockEnabled: Bool = true

  let onLoadStart = EventDispatcher()
  let onLoadEnd = EventDispatcher()

  private let webView: WKWebView
  private var loadedUrl: String?
  private var appliedAdBlockEnabled: Bool?
  private var hasFinishedInitialLoad = false
  private var initialLoadFailed = false
  private var hasAttemptedOfflineFallback = false
  private var isShowingOfflineFallback = false
  private var isLoadInProgress = false
  private var pendingTargetLoad = false
  private var pendingLoadGeneration: UInt64 = 0

  public required init(appContext: AppContext? = nil) {
    let configuration = WKWebViewConfiguration()
    configuration.allowsInlineMediaPlayback = true
    let createdWebView = WKWebView(frame: .zero, configuration: configuration)
    createdWebView.allowsBackForwardNavigationGestures = true
    self.webView = createdWebView

    super.init(appContext: appContext)

    createdWebView.navigationDelegate = self
    createdWebView.uiDelegate = self
    addSubview(createdWebView)

    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleRulesUpdated),
      name: MusubiAdBlockRuleStore.rulesDidUpdateNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    webView.frame = bounds
  }

  @objc private func handleRulesUpdated() {
    guard adBlockEnabled, let ruleList = MusubiAdBlockRuleStore.shared.cachedRuleList else {
      return
    }
    applyContentRuleList(ruleList)
  }

  func applyPendingUpdates() {
    let normalizedUrl = url.trimmingCharacters(in: .whitespacesAndNewlines)
    let urlChanged = normalizedUrl != loadedUrl
    let adBlockChanged = adBlockEnabled != appliedAdBlockEnabled

    if !urlChanged && !adBlockChanged {
      if initialLoadFailed && !isShowingOfflineFallback && !hasAttemptedOfflineFallback {
        _ = loadOfflineHtmlIfAvailable(baseUrlString: normalizedUrl)
      }
      return
    }

    if urlChanged {
      loadedUrl = normalizedUrl
      hasFinishedInitialLoad = false
      initialLoadFailed = false
      hasAttemptedOfflineFallback = false
      isShowingOfflineFallback = false
      isLoadInProgress = false
      pendingTargetLoad = true
    }

    pendingLoadGeneration &+= 1
    let generation = pendingLoadGeneration

    if adBlockEnabled {
      MusubiAdBlockRuleStore.shared.lookupOrFetchRuleList { [weak self] ruleList in
        guard let self, self.pendingLoadGeneration == generation else {
          return
        }
        self.applyContentRuleList(ruleList)
        self.appliedAdBlockEnabled = true
        self.triggerLoadOrReload(
          urlChanged: urlChanged,
          adBlockChanged: adBlockChanged,
          targetUrl: normalizedUrl
        )
      }
    } else {
      applyContentRuleList(nil)
      appliedAdBlockEnabled = false
      triggerLoadOrReload(
        urlChanged: urlChanged,
        adBlockChanged: adBlockChanged,
        targetUrl: normalizedUrl
      )
    }
  }

  private func triggerLoadOrReload(urlChanged: Bool, adBlockChanged: Bool, targetUrl: String) {
    if urlChanged || pendingTargetLoad {
      pendingTargetLoad = false
      loadCurrentTarget(targetUrl)
    } else if adBlockChanged && !isShowingOfflineFallback {
      webView.reload()
    }
  }

  private func applyContentRuleList(_ ruleList: WKContentRuleList?) {
    let controller = webView.configuration.userContentController
    controller.removeAllContentRuleLists()
    if let ruleList {
      controller.add(ruleList)
    }
  }

  private func loadCurrentTarget(_ targetUrlString: String) {
    guard !targetUrlString.isEmpty else {
      return
    }

    guard let targetUrl = URL(string: targetUrlString),
          let scheme = targetUrl.scheme?.lowercased(),
          scheme == "http" || scheme == "https" else {
      if !loadOfflineHtmlIfAvailable(baseUrlString: targetUrlString) {
        onLoadEnd([
          "url": targetUrlString,
          "success": false,
          "usedOfflineFallback": false,
          "error": "Invalid article URL"
        ])
      }
      return
    }

    var request = URLRequest(url: targetUrl)
    request.timeoutInterval = 15
    webView.load(request)
  }

  private func resolveLocalFileURL(_ path: String) -> URL? {
    if path.hasPrefix("file://") {
      return URL(string: path)
    }
    return URL(fileURLWithPath: path)
  }

  private func decodeHtmlData(_ data: Data) -> String? {
    let encodings: [String.Encoding] = [.utf8, .shiftJIS, .japaneseEUC, .isoLatin1]
    for encoding in encodings {
      if let text = String(data: data, encoding: encoding) {
        return text
      }
    }
    return nil
  }

  private func loadOfflineHtmlIfAvailable(baseUrlString: String) -> Bool {
    guard let path = offlineHtmlPath?.trimmingCharacters(in: .whitespacesAndNewlines),
          !path.isEmpty,
          let fileUrl = resolveLocalFileURL(path),
          let data = try? Data(contentsOf: fileUrl),
          let html = decodeHtmlData(data) else {
      return false
    }

    hasAttemptedOfflineFallback = true
    isShowingOfflineFallback = true
    if !isLoadInProgress {
      isLoadInProgress = true
      onLoadStart(["url": baseUrlString])
    }
    webView.loadHTMLString(html, baseURL: URL(string: baseUrlString))
    return true
  }

  private func currentEventUrl() -> String {
    if isShowingOfflineFallback {
      return loadedUrl ?? url
    }
    if let active = webView.url?.absoluteString, !active.isEmpty {
      return active
    }
    return loadedUrl ?? url
  }

  private func handleNavigationFailure(error: Error) {
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
      return
    }

    let currentUrl = loadedUrl ?? url
    if !hasFinishedInitialLoad && !hasAttemptedOfflineFallback {
      if loadOfflineHtmlIfAvailable(baseUrlString: currentUrl) {
        return
      }
      initialLoadFailed = true
    }

    isLoadInProgress = false
    onLoadEnd([
      "url": currentUrl,
      "success": false,
      "usedOfflineFallback": isShowingOfflineFallback,
      "error": error.localizedDescription
    ])
  }

  // MARK: - WKNavigationDelegate

  public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    if !isLoadInProgress {
      isLoadInProgress = true
      onLoadStart(["url": currentEventUrl()])
    }
  }

  public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    isLoadInProgress = false
    hasFinishedInitialLoad = true
    initialLoadFailed = false
    onLoadEnd([
      "url": currentEventUrl(),
      "success": true,
      "usedOfflineFallback": isShowingOfflineFallback
    ])
  }

  public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    handleNavigationFailure(error: error)
  }

  public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    handleNavigationFailure(error: error)
  }

  public func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let requestUrl = navigationAction.request.url,
          let scheme = requestUrl.scheme?.lowercased() else {
      decisionHandler(.cancel)
      return
    }

    if scheme == "http" || scheme == "https" || scheme == "about" || scheme == "data" || scheme == "blob" {
      decisionHandler(.allow)
      return
    }

    decisionHandler(.cancel)
  }

  // MARK: - WKUIDelegate

  public func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if navigationAction.targetFrame == nil, let targetUrl = navigationAction.request.url {
      let scheme = targetUrl.scheme?.lowercased()
      if scheme == "http" || scheme == "https" {
        webView.load(navigationAction.request)
      }
    }
    return nil
  }
}
