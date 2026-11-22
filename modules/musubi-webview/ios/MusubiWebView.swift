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
        if self?.cachedRuleList == nil, let ruleList {
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
  var preferOfflineCache: Bool = false
  var ignoreHttpCache: Bool = false

  let onLoadStart = EventDispatcher()
  let onLoadEnd = EventDispatcher()

  private let webView: WKWebView
  private var loadedUrl: String?
  private var appliedAdBlockEnabled: Bool?
  private var appliedPreferOfflineCache: Bool?
  private var allowedOfflineDirectory: URL?
  private var hasFinishedInitialLoad = false
  private var initialLoadFailed = false
  private var hasAttemptedOfflineFallback = false
  private var isShowingOfflineFallback = false
  private var isLoadInProgress = false
  private var loadStartedAt: CFTimeInterval?
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
    let preferCacheChanged = preferOfflineCache != appliedPreferOfflineCache

    if !urlChanged && !adBlockChanged && !preferCacheChanged {
      if initialLoadFailed && !isShowingOfflineFallback && !hasAttemptedOfflineFallback {
        _ = loadOfflineHtmlIfAvailable(baseUrlString: normalizedUrl)
      }
      return
    }

    if urlChanged || preferCacheChanged {
      loadedUrl = normalizedUrl
      appliedPreferOfflineCache = preferOfflineCache
      allowedOfflineDirectory = nil
      hasFinishedInitialLoad = false
      initialLoadFailed = false
      hasAttemptedOfflineFallback = false
      isShowingOfflineFallback = false
      isLoadInProgress = false
      loadStartedAt = nil
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
          urlChanged: urlChanged || preferCacheChanged,
          adBlockChanged: adBlockChanged,
          targetUrl: normalizedUrl
        )
      }
    } else {
      applyContentRuleList(nil)
      appliedAdBlockEnabled = false
      triggerLoadOrReload(
        urlChanged: urlChanged || preferCacheChanged,
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

    if preferOfflineCache && loadOfflineHtmlIfAvailable(baseUrlString: targetUrlString) {
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
          "durationMs": 0,
          "error": "Invalid article URL"
        ])
      }
      return
    }

    loadStartedAt = CACurrentMediaTime()
    var request = URLRequest(url: targetUrl)
    request.timeoutInterval = 15
    if ignoreHttpCache {
      request.cachePolicy = .reloadIgnoringLocalCacheData
    }
    webView.load(request)
  }

  private func resolveLocalFileURL(_ path: String) -> URL? {
    if path.hasPrefix("file://") {
      return URL(string: path)
    }
    return URL(fileURLWithPath: path)
  }

  private func isFileUrl(_ fileUrl: URL, inside directoryUrl: URL) -> Bool {
    let resolvedFile = fileUrl.resolvingSymlinksInPath().standardizedFileURL.path
    let resolvedDir = directoryUrl.resolvingSymlinksInPath().standardizedFileURL.path
    let dirPrefix = resolvedDir.hasSuffix("/") ? resolvedDir : resolvedDir + "/"
    return resolvedFile == resolvedDir || resolvedFile.hasPrefix(dirPrefix)
  }

  private func extractDeclaredCharset(from data: Data) -> String.Encoding? {
    if data.starts(with: [0xEF, 0xBB, 0xBF]) {
      return .utf8
    }

    let prefixCount = min(data.count, 4096)
    guard prefixCount > 0,
          let head = String(data: data.prefix(prefixCount), encoding: .isoLatin1) else {
      return nil
    }

    let pattern = #"<meta\b[^>]*\bcharset\s*=\s*["']?([A-Za-z0-9._-]+)"#
    guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
          let match = regex.firstMatch(in: head, range: NSRange(head.startIndex..., in: head)),
          let range = Range(match.range(at: 1), in: head) else {
      return nil
    }

    let charsetName = String(head[range]).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    switch charsetName {
    case "utf-8", "utf8":
      return .utf8
    case "euc-jp", "euc_jp", "eucjp", "x-euc-jp":
      return .japaneseEUC
    case "shift_jis", "shift-jis", "sjis", "x-sjis", "ms_kanji", "cp932", "ms932", "windows-31j":
      return .shiftJIS
    case "iso-2022-jp", "csiso2022jp":
      return .iso2022JP
    case "iso-8859-1", "latin1":
      return .isoLatin1
    default:
      let cfEncoding = CFStringConvertIANACharSetNameToEncoding(charsetName as CFString)
      if cfEncoding != kCFStringEncodingInvalidId {
        let nsEncoding = CFStringConvertEncodingToNSStringEncoding(cfEncoding)
        return String.Encoding(rawValue: nsEncoding)
      }
      return nil
    }
  }

  private func decodeHtmlData(_ data: Data) -> String? {
    var encodings: [String.Encoding] = []
    if let declared = extractDeclaredCharset(from: data) {
      encodings.append(declared)
    }
    for fallback: String.Encoding in [.utf8, .japaneseEUC, .shiftJIS, .isoLatin1] {
      if !encodings.contains(fallback) {
        encodings.append(fallback)
      }
    }
    for encoding in encodings {
      if let text = String(data: data, encoding: encoding) {
        return text
      }
    }
    return nil
  }

  private func ensureUtf8MetaCharset(in html: String) -> String {
    guard let metaRegex = try? NSRegularExpression(pattern: #"<meta\b[^>]*>"#, options: [.caseInsensitive]),
          let charsetRegex = try? NSRegularExpression(pattern: #"(charset\s*=\s*["']?)[A-Za-z0-9._-]+"#, options: [.caseInsensitive]) else {
      return "<meta charset=\"utf-8\">" + html
    }

    let matches = metaRegex.matches(in: html, range: NSRange(html.startIndex..., in: html))
    var replacedCharset = false
    var mutableHtml = html

    for match in matches.reversed() {
      guard let swiftRange = Range(match.range, in: mutableHtml) else {
        continue
      }
      let tag = String(mutableHtml[swiftRange])
      let tagNsRange = NSRange(tag.startIndex..., in: tag)
      if charsetRegex.firstMatch(in: tag, range: tagNsRange) != nil {
        replacedCharset = true
        let updatedTag = charsetRegex.stringByReplacingMatches(
          in: tag,
          range: tagNsRange,
          withTemplate: "$1utf-8"
        )
        mutableHtml.replaceSubrange(swiftRange, with: updatedTag)
      }
    }

    if replacedCharset {
      return mutableHtml
    }
    if let headRange = mutableHtml.range(of: #"<head\b[^>]*>"#, options: [.regularExpression, .caseInsensitive]) {
      mutableHtml.insert(contentsOf: "<meta charset=\"utf-8\">", at: headRange.upperBound)
      return mutableHtml
    }
    return "<meta charset=\"utf-8\">" + mutableHtml
  }

  private func prepareOfflineFileURL(_ fileUrl: URL, in cacheDir: URL) -> URL? {
    guard let data = try? Data(contentsOf: fileUrl) else {
      return nil
    }
    if extractDeclaredCharset(from: data) == .utf8,
       String(data: data, encoding: .utf8) != nil {
      return fileUrl
    }
    guard let decoded = decodeHtmlData(data) else {
      return nil
    }
    let utf8Html = ensureUtf8MetaCharset(in: decoded)
    guard let utf8Data = utf8Html.data(using: .utf8) else {
      return nil
    }
    let normalizedUrl = cacheDir.appendingPathComponent("index.utf8.html")
    do {
      try utf8Data.write(to: normalizedUrl, options: .atomic)
      return normalizedUrl
    } catch {
      return nil
    }
  }

  private func loadOfflineHtmlIfAvailable(baseUrlString: String) -> Bool {
    guard let path = offlineHtmlPath?.trimmingCharacters(in: .whitespacesAndNewlines),
          !path.isEmpty,
          let fileUrl = resolveLocalFileURL(path),
          fileUrl.isFileURL,
          FileManager.default.isReadableFile(atPath: fileUrl.path) else {
      return false
    }

    let cacheDir = fileUrl.deletingLastPathComponent().standardizedFileURL
    guard let targetFileUrl = prepareOfflineFileURL(fileUrl, in: cacheDir) else {
      return false
    }

    allowedOfflineDirectory = cacheDir
    hasAttemptedOfflineFallback = true
    isShowingOfflineFallback = true
    loadStartedAt = CACurrentMediaTime()
    if !isLoadInProgress {
      isLoadInProgress = true
      onLoadStart(["url": baseUrlString])
    }
    webView.loadFileURL(targetFileUrl, allowingReadAccessTo: cacheDir)
    return true
  }

  private func elapsedDurationMs() -> Int {
    guard let startedAt = loadStartedAt else {
      return 0
    }
    return max(0, Int(((CACurrentMediaTime() - startedAt) * 1000.0).rounded()))
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

    let durationMs = elapsedDurationMs()
    loadStartedAt = nil
    isLoadInProgress = false
    onLoadEnd([
      "url": currentUrl,
      "success": false,
      "usedOfflineFallback": isShowingOfflineFallback,
      "durationMs": durationMs,
      "error": error.localizedDescription
    ])
  }

  // MARK: - WKNavigationDelegate

  public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    if loadStartedAt == nil {
      loadStartedAt = CACurrentMediaTime()
    }
    if !isLoadInProgress {
      isLoadInProgress = true
      onLoadStart(["url": currentEventUrl()])
    }
  }

  public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    let durationMs = elapsedDurationMs()
    loadStartedAt = nil
    isLoadInProgress = false
    hasFinishedInitialLoad = true
    initialLoadFailed = false
    onLoadEnd([
      "url": currentEventUrl(),
      "success": true,
      "usedOfflineFallback": isShowingOfflineFallback,
      "durationMs": durationMs
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

    if scheme == "file" {
      if isShowingOfflineFallback,
         let allowedDir = allowedOfflineDirectory,
         isFileUrl(requestUrl, inside: allowedDir) {
        decisionHandler(.allow)
        return
      }
      decisionHandler(.cancel)
      return
    }

    if scheme == "http" || scheme == "https" || scheme == "about" || scheme == "data" || scheme == "blob" {
      if isShowingOfflineFallback && (scheme == "http" || scheme == "https") && (navigationAction.targetFrame?.isMainFrame ?? true) {
        isShowingOfflineFallback = false
      }
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
