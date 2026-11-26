import ExpoModulesCore

public final class MusubiWebViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MusubiWebView")

    AsyncFunction("compileAdBlockRules") { (rulesJson: String, fallbackRulesJson: String?, promise: Promise) in
      Task { @MainActor in
        MusubiAdBlockRuleStore.shared.compileRules(
          primaryJson: rulesJson,
          fallbackJson: fallbackRulesJson
        ) { result in
          promise.resolve(result)
        }
      }
    }

    View(MusubiWebView.self) {
      Events("onLoadStart", "onLoadEnd", "onAutoScrollStateChange")

      Prop("url") { (view, url: String?) in
        view.url = url ?? ""
      }

      Prop("offlineHtmlPath") { (view, offlineHtmlPath: String?) in
        view.offlineHtmlPath = offlineHtmlPath
      }

      Prop("adBlockEnabled", true) { (view, adBlockEnabled: Bool) in
        view.adBlockEnabled = adBlockEnabled
      }

      Prop("preferOfflineCache", false) { (view, preferOfflineCache: Bool) in
        view.preferOfflineCache = preferOfflineCache
      }

      Prop("ignoreHttpCache", false) { (view, ignoreHttpCache: Bool) in
        view.ignoreHttpCache = ignoreHttpCache
      }

      Prop("autoScrollEnabled", false) { (view, autoScrollEnabled: Bool) in
        view.autoScrollEnabled = autoScrollEnabled
      }

      Prop("autoScrollSpeed", 40.0) { (view, autoScrollSpeed: Double) in
        view.autoScrollSpeed = max(0, autoScrollSpeed)
      }

      OnViewDidUpdateProps { view in
        view.applyPendingUpdates()
      }
    }
  }
}
