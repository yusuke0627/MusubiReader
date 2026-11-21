import ExpoModulesCore

public final class MusubiWebViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MusubiWebView")

    AsyncFunction("compileAdBlockRules") { (rulesJson: String, fallbackRulesJson: String?, promise: Promise) in
      MusubiAdBlockRuleStore.shared.compileRules(
        primaryJson: rulesJson,
        fallbackJson: fallbackRulesJson
      ) { result in
        promise.resolve(result)
      }
    }
    .runOnQueue(.main)

    View(MusubiWebView.self) {
      Events("onLoadStart", "onLoadEnd")

      Prop("url") { (view, url: String?) in
        view.url = url ?? ""
      }

      Prop("offlineHtmlPath") { (view, offlineHtmlPath: String?) in
        view.offlineHtmlPath = offlineHtmlPath
      }

      Prop("adBlockEnabled", true) { (view, adBlockEnabled: Bool) in
        view.adBlockEnabled = adBlockEnabled
      }

      OnViewDidUpdateProps { view in
        view.applyPendingUpdates()
      }
    }
  }
}
