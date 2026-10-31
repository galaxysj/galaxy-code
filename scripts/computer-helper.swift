// Works in other apps' windows without touching the user's pointer or keyboard focus.
// Takes one JSON request as its argument and prints one JSON reply.
//
// Clicks go through the accessibility API, by ref or by point, or are posted to the window in place,
// which leaves the user's pointer and keyboard focus alone. Events only reach a window that is not
// under the pointer when they name it, which takes the private field and call below.
// With full control, requests marked global act on the whole screen with the real pointer and keyboard.
// Run with the argument hide-cursor, it hides the real cursor until it is killed.

import AppKit
import ApplicationServices

struct Failure: Error {
  let message: String
}

typealias Request = [String: Any]

let MAX_NODES = 500
/** The event field AppKit reads a window number from. */
let WINDOW_FIELD = CGEventField(rawValue: 51)!
let setWindowLocation: (@convention(c) (CGEvent, CGPoint) -> Void)? = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
  .flatMap { dlsym($0, "CGEventSetWindowLocation") }
  .map { unsafeBitCast($0, to: (@convention(c) (CGEvent, CGPoint) -> Void).self) }
let MAX_DEPTH = 40
/** Layout containers with nothing to read or press. Their children still appear. */
let NOISE: Set<String> = ["AXGroup", "AXSplitGroup", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXScrollArea"]

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func text(_ element: AXUIElement, _ name: String, limit: Int = 200) -> String {
  guard let value = attribute(element, name) else { return "" }
  let string = (value as? String) ?? (value as? NSNumber)?.stringValue ?? ""
  return String(string.prefix(limit))
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  return (attribute(element, "AXChildren") as? [AXUIElement]) ?? []
}

func axValue<T>(_ element: AXUIElement, _ name: String, _ type: AXValueType, _ empty: T) -> T? {
  guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  var result = empty
  return AXValueGetValue(value as! AXValue, type, &result) ? result : nil
}

func frame(_ element: AXUIElement) -> CGRect? {
  guard let origin = axValue(element, "AXPosition", .cgPoint, CGPoint.zero), let size = axValue(element, "AXSize", .cgSize, CGSize.zero) else { return nil }
  return CGRect(origin: origin, size: size)
}

func actions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
  return (names as? [String]) ?? []
}

func settable(_ element: AXUIElement, _ name: String) -> Bool {
  var result = DarwinBoolean(false)
  return AXUIElementIsAttributeSettable(element, name as CFString, &result) == .success && result.boolValue
}

func label(_ element: AXUIElement) -> String {
  for name in ["AXTitle", "AXDescription", "AXHelp"] {
    let value = text(element, name)
    if !value.isEmpty { return value }
  }
  return ""
}

func summary(_ element: AXUIElement) -> String {
  let name = label(element)
  return text(element, "AXRole").replacingOccurrences(of: "AX", with: "") + (name.isEmpty ? "" : " \"\(name)\"")
}

func number(_ request: Request, _ key: String) throws -> Double {
  guard let value = request[key] as? NSNumber else { throw Failure(message: "Missing \(key)") }
  return value.doubleValue
}

func pid(_ request: Request) throws -> pid_t {
  return pid_t(try number(request, "pid"))
}

func application(_ request: Request) throws -> AXUIElement {
  let element = AXUIElementCreateApplication(try pid(request))
  // Electron apps only build their tree once a client asks for it.
  AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  return element
}

/** The accessibility element of the window the service picked by its on-screen frame. */
func windowElement(_ app: AXUIElement, _ request: Request) throws -> AXUIElement {
  let windows = (attribute(app, "AXWindows") as? [AXUIElement]) ?? []
  let target = CGRect(x: try number(request, "x"), y: try number(request, "y"), width: try number(request, "width"), height: try number(request, "height"))
  let match = windows.first { element in
    guard let box = frame(element) else { return false }
    return abs(box.minX - target.minX) < 3 && abs(box.minY - target.minY) < 3 && abs(box.width - target.width) < 3 && abs(box.height - target.height) < 3
  }
  guard let window = match ?? windows.first else { throw Failure(message: "This app does not expose its window to accessibility") }
  return window
}

/** Alerts and panels the app has open beside the window (d), and its open menus (a). */
func extras(_ app: AXUIElement, _ request: Request) -> [(String, AXUIElement)] {
  var found: [(String, AXUIElement)] = []
  let main = try? windowElement(app, request)
  for (index, window) in ((attribute(app, "AXWindows") as? [AXUIElement]) ?? []).enumerated() {
    if let main = main, CFEqual(main, window) { continue }
    let modal = (attribute(window, "AXModal") as? Bool) == true
    if modal || ["AXDialog", "AXSystemDialog", "AXFloatingWindow"].contains(text(window, "AXSubrole")) { found.append(("d\(index)", window)) }
  }
  // Finder keeps the desktop here too, which is always there and is not something that opened.
  for (index, child) in children(app).enumerated() where ["AXMenu", "AXPopover"].contains(text(child, "AXRole")) {
    found.append(("a\(index)", child))
  }
  return found
}

/** What has opened that the agent should look at, so it does not go on as if nothing happened. */
func openDialogs(_ app: AXUIElement, _ request: Request) -> [String] {
  usleep(300_000)
  var names = extras(app, request).map { summary($0.1) }
  if let main = try? windowElement(app, request) {
    names += children(main).filter { text($0, "AXRole") == "AXSheet" }.map(summary)
  }
  return names
}

func root(_ app: AXUIElement, _ request: Request, _ name: String) throws -> AXUIElement {
  if name == "m" {
    guard let bar = attribute(app, "AXMenuBar") else { throw Failure(message: "This app has no menu bar") }
    return bar as! AXUIElement
  }
  if name == "w" { return try windowElement(app, request) }
  guard let element = extras(app, request).first(where: { $0.0 == name })?.1 else { throw Failure(message: "\(name) is not open any more. Read the tree again.") }
  return element
}

/** Refs are paths of child indexes from a root: the window (w), the menu bar (m), a dialog (d) or an open menu (a). */
func resolve(_ app: AXUIElement, _ request: Request) throws -> AXUIElement {
  guard let ref = request["ref"] as? String else { throw Failure(message: "Missing ref") }
  let parts = ref.split(separator: ".").map(String.init)
  guard let first = parts.first else { throw Failure(message: "Bad ref \(ref)") }
  var element = try root(app, request, first)
  for part in parts.dropFirst() {
    let list = children(element)
    guard let index = Int(part), index < list.count else { throw Failure(message: "No element at \(ref). Read the tree again.") }
    element = list[index]
  }
  // A ref is only a position, so make sure it still holds what the tree showed.
  if let role = request["role"] as? String, role != text(element, "AXRole") { throw Failure(message: "The element at \(ref) changed. Read the tree again.") }
  if let title = request["title"] as? String, title != label(element) { throw Failure(message: "The element at \(ref) changed. Read the tree again.") }
  return element
}

func target(_ app: AXUIElement, _ request: Request) throws -> AXUIElement {
  if request["ref"] is String { return try resolve(app, request) }
  var element: AXUIElement?
  let status = AXUIElementCopyElementAtPosition(app, Float(try number(request, "pointX")), Float(try number(request, "pointY")), &element)
  guard status == .success, let found = element else { throw Failure(message: "No accessible element at that point (\(status.rawValue)). Read the tree instead.") }
  return found
}

func ancestors(_ element: AXUIElement) -> [AXUIElement] {
  var chain = [element]
  while chain.count < 8, let parent = attribute(chain[chain.count - 1], "AXParent"), text(parent as! AXUIElement, "AXRole") != "AXWindow" {
    chain.append(parent as! AXUIElement)
  }
  return chain
}

func perform(_ element: AXUIElement, _ action: String) -> Bool {
  let status = AXUIElementPerformAction(element, action as CFString)
  // Some apps answer late when an action opens a modal menu or sheet, though it did happen.
  return status == .success || status == .cannotComplete
}

/** The web page holding an element, if any. */
func webArea(_ element: AXUIElement) -> AXUIElement? {
  var current = element
  for _ in 0..<40 {
    if text(current, "AXRole") == "AXWebArea" { return current }
    guard let parent = attribute(current, "AXParent") else { return nil }
    current = parent as! AXUIElement
  }
  return nil
}

/** What a page shows, in a form that can be compared before and after a press. */
func signature(_ area: AXUIElement) -> String {
  var parts: [String] = []
  var pending = [area]
  while let element = pending.popLast(), parts.count < 250 {
    parts.append(label(element) + "|" + text(element, "AXValue", limit: 60) + "|" + String(describing: attribute(element, "AXSelected")))
    pending += children(element).reversed()
  }
  return parts.joined(separator: "\n")
}

/** A click posted to the app, which leaves the real pointer where it is. */
func clickInPlace(_ request: Request, _ point: CGPoint, kind: String) throws {
  let right = kind == "menu"
  let (down, up): (CGEventType, CGEventType) = right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
  for count in 1...Int64(kind == "open" ? 2 : 1) {
    for type in [down, up] {
      guard let event = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: type, mouseCursorPosition: point, mouseButton: right ? .right : .left) else { throw Failure(message: "Could not create a mouse event") }
      event.setIntegerValueField(.mouseEventClickState, value: count)
      event.setDoubleValueField(.mouseEventPressure, value: type == down ? 1 : 0)
      try address(event, request, point)
      event.postToPid(try pid(request))
      usleep(30_000)
    }
  }
}

/** Where to click an element: the middle of its frame, or of the part inside the window. */
func clickPoint(_ app: AXUIElement, _ element: AXUIElement, _ request: Request) -> CGPoint? {
  if let x = (request["pointX"] as? NSNumber)?.doubleValue, let y = (request["pointY"] as? NSNumber)?.doubleValue { return CGPoint(x: x, y: y) }
  guard let box = frame(element) else { return nil }
  let window = CGRect(x: (request["x"] as? NSNumber)?.doubleValue ?? 0, y: (request["y"] as? NSNumber)?.doubleValue ?? 0, width: (request["width"] as? NSNumber)?.doubleValue ?? 0, height: (request["height"] as? NSNumber)?.doubleValue ?? 0)
  let visible = box.intersection(window)
  return visible.isNull ? nil : CGPoint(x: visible.midX, y: visible.midY)
}

/** Presses the element by name when it has such an action, and clicks where it is when it has none or a page ignores it. */
func click(_ app: AXUIElement, _ request: Request) throws -> Request {
  let start = try target(app, request)
  let kind = (request["kind"] as? String) ?? "press"
  let wanted = kind == "menu" ? ["AXShowMenu"] : kind == "open" ? ["AXOpen"] : ["AXPress"]
  // A press reaches a page as a bare click event, which pages that watch pointerdown never notice.
  let page = webArea(start)
  let before = page.map(signature)
  var pressed: String?
  search: for element in ancestors(start) {
    for action in wanted where actions(element).contains(action) {
      // The element may be gone once it has been pressed, so name it first.
      let name = summary(element)
      if perform(element, action) { pressed = "\(action) on \(name)"; break search }
    }
  }
  var dialogs = pressed == nil ? [] : openDialogs(app, request)
  if let done = pressed, dialogs.isEmpty, let page = page, { usleep(300_000); return signature(page) == before }() == false {
    return ["done": done, "dialogs": dialogs]
  }
  if let done = pressed, page == nil || !dialogs.isEmpty { return ["done": done, "dialogs": dialogs] }
  guard let point = clickPoint(app, start, request) else {
    if let done = pressed { return ["done": done, "dialogs": dialogs, "unchanged": true] }
    throw Failure(message: "\(summary(start)) is not on screen, so it cannot be clicked.")
  }
  // Normal apps show a click in their tree too, so a click in place is checked against the window.
  let scope = page ?? (try? windowElement(app, request))
  let earlier = page == nil ? scope.map(signature) : before
  if settable(start, "AXFocused") { AXUIElementSetAttributeValue(start, "AXFocused" as CFString, kCFBooleanTrue) }
  try clickInPlace(request, point, kind: kind)
  dialogs = openDialogs(app, request)
  var reply: Request = ["done": "Clicked \(summary(start)) in place", "dialogs": dialogs]
  if let scope = scope, dialogs.isEmpty {
    usleep(300_000)
    if signature(scope) == earlier { reply["unchanged"] = true }
  }
  return reply
}

/** Sets what an event needs so that AppKit hands it to the window instead of dropping it. */
func address(_ event: CGEvent, _ request: Request, _ point: CGPoint) throws {
  let id = Int64(try number(request, "windowId"))
  event.setIntegerValueField(WINDOW_FIELD, value: id)
  event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: id)
  event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: id)
  setWindowLocation?(event, CGPoint(x: point.x - (try number(request, "x")), y: point.y - (try number(request, "y"))))
}

func postMouse(_ request: Request, _ type: CGEventType, _ point: CGPoint, button: CGMouseButton = .left, clicks: Int64 = 0, flags: UInt64 = 0) throws {
  guard let event = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw Failure(message: "Could not create a mouse event") }
  if clicks > 0 { event.setIntegerValueField(.mouseEventClickState, value: clicks) }
  event.setDoubleValueField(.mouseEventPressure, value: [CGEventType.leftMouseUp, .rightMouseUp, .mouseMoved].contains(type) ? 0 : 1)
  event.flags = CGEventFlags(rawValue: flags)
  event.post(tap: .cghidEventTap)
}

/** Moves the real pointer to a point the way the browser's agent cursor moves: along a slight curve that differs each time, easing out. */
func glide(_ request: Request, to point: CGPoint, flags: UInt64) throws {
  let from = CGEvent(source: nil)?.location ?? point
  let distance = hypot(point.x - from.x, point.y - from.y)
  if distance >= 2 && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
    let duration = min(0.42, (0.16 + Double(distance) * 0.00022) * Double.random(in: 0.9...1.2))
    let bow = min(120, distance * CGFloat.random(in: 0.06...0.2)) * (Bool.random() ? 1 : -1)
    let control = CGPoint(x: (from.x + point.x) / 2 - (point.y - from.y) / distance * bow, y: (from.y + point.y) / 2 + (point.x - from.x) / distance * bow)
    let start = Date()
    while true {
      let share = min(1, Date().timeIntervalSince(start) / duration)
      let t = CGFloat(1 - pow(1 - share, 3))
      let x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * control.x + t * t * point.x
      let y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * control.y + t * t * point.y
      try postMouse(request, .mouseMoved, CGPoint(x: x, y: y), flags: flags)
      if share >= 1 { return }
      usleep(8_000)
    }
  }
  try postMouse(request, .mouseMoved, point, flags: flags)
}

/** Brings the target app forward for the real pointer, and stops if it did not come. */
func bringForward(_ app: AXUIElement, _ request: Request) throws {
  AXUIElementSetAttributeValue(app, "AXFrontmost" as CFString, kCFBooleanTrue)
  if let window = try? windowElement(app, request) { AXUIElementPerformAction(window, "AXRaise" as CFString) }
  for _ in 0..<50 where (attribute(app, "AXFrontmost") as? Bool) != true { usleep(10_000) }
  guard (attribute(app, "AXFrontmost") as? Bool) == true else { throw Failure(message: "The app could not be brought to the front") }
  usleep(150_000)
}

func isGlobal(_ request: Request) -> Bool {
  return (request["global"] as? Bool) == true
}

/** The real pointer hits whatever is on top, so make sure that is allowed. */
func requireOnTop(_ point: CGPoint, _ request: Request) throws {
  let rows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  for row in rows {
    guard let layer = row[kCGWindowLayer as String] as? Int, layer >= 0, layer <= 8, let bounds = row[kCGWindowBounds as String] as? [String: Double] else { continue }
    guard CGRect(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0, width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0).contains(point) else { continue }
    if isGlobal(request) {
      // Even the whole screen leaves out the app's approval prompts and the system's password prompts.
      let blocked = (request["blockedApps"] as? [String]) ?? []
      let windows = (request["blockedWindows"] as? [Int]) ?? []
      if windows.contains((row[kCGWindowNumber as String] as? Int) ?? 0) || blocked.contains((row[kCGWindowOwnerName as String] as? String) ?? "") {
        throw Failure(message: "That point is on Galaxy Code or a system prompt, which agents cannot use")
      }
      return
    }
    if (row[kCGWindowOwnerPID as String] as? pid_t) == (try pid(request)) { return }
    throw Failure(message: "Another window covers that point, so the pointer was not used")
  }
  if !isGlobal(request) { throw Failure(message: "That point is outside the app's windows") }
}

/** Moves, clicks or drags along request.points, which are global display points. */
func pointer(_ app: AXUIElement, _ request: Request) throws -> Request {
  let points = ((request["points"] as? [[Double]]) ?? []).map { CGPoint(x: $0[0], y: $0[1]) }
  guard let first = points.first, let last = points.last else { throw Failure(message: "Missing points") }
  let right = (request["button"] as? String) == "right"
  let button: CGMouseButton = right ? .right : .left
  let flags = UInt64((request["flags"] as? NSNumber)?.intValue ?? 0)
  let (down, up, dragged): (CGEventType, CGEventType, CGEventType) = right ? (.rightMouseDown, .rightMouseUp, .rightMouseDragged) : (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
  if !isGlobal(request) { try bringForward(app, request) }
  for point in points { try requireOnTop(point, request) }
  try glide(request, to: first, flags: flags)
  usleep(20_000)
  switch request["kind"] as? String {
  case "move":
    for point in points.dropFirst() { try glide(request, to: point, flags: flags) }
    return ["done": "Moved"]
  case "drag":
    try postMouse(request, down, first, button: button, clicks: 1, flags: flags)
    usleep(40_000)
    var previous = first
    for point in points.dropFirst() {
      // Small steps, so that apps which sample the pointer draw a line and not dots.
      let steps = max(1, Int(hypot(point.x - previous.x, point.y - previous.y) / 6))
      for step in 1...steps {
        let share = CGFloat(step) / CGFloat(steps)
        try postMouse(request, dragged, CGPoint(x: previous.x + (point.x - previous.x) * share, y: previous.y + (point.y - previous.y) * share), button: button, clicks: 1, flags: flags)
        usleep(8_000)
      }
      previous = point
    }
    usleep(40_000)
    try postMouse(request, up, last, button: button, clicks: 1, flags: flags)
    return ["done": "Dragged"]
  default:
    let count = max(1, Int64((request["count"] as? NSNumber)?.intValue ?? 1))
    for click in 1...count {
      try postMouse(request, down, first, button: button, clicks: click, flags: flags)
      usleep(20_000)
      try postMouse(request, up, first, button: button, clicks: click, flags: flags)
      usleep(40_000)
    }
    return ["done": count > 1 ? "Clicked \(count) times" : "Clicked"]
  }
}

func tree(_ app: AXUIElement, _ request: Request) throws -> Request {
  var nodes: [Request] = []
  func walk(_ element: AXUIElement, _ ref: String, _ depth: Int) {
    if nodes.count >= MAX_NODES || depth > MAX_DEPTH { return }
    let role = text(element, "AXRole")
    let title = label(element)
    // Password fields keep their value to themselves.
    let secure = text(element, "AXSubrole") == "AXSecureTextField" || role == "AXSecureTextField"
    let value = secure ? "" : text(element, "AXValue", limit: 300)
    if !NOISE.contains(role) || !title.isEmpty || !value.isEmpty {
      var node: Request = ["ref": ref, "role": role, "title": title, "value": value, "actions": actions(element).filter { !$0.hasPrefix("AXScroll") }]
      if (attribute(element, "AXEnabled") as? Bool) == false { node["disabled"] = true }
      if (attribute(element, "AXFocused") as? Bool) == true { node["focused"] = true }
      if let box = frame(element) { node["frame"] = [box.minX, box.minY, box.width, box.height].map { Double($0) } }
      nodes.append(node)
    }
    for (index, child) in children(element).enumerated() { walk(child, "\(ref).\(index)", depth + 1) }
  }
  if (request["menu"] as? Bool) == true {
    walk(try root(app, request, "m"), "m", 0)
  } else {
    // What is open on top comes first, so a long window cannot push it past the limit.
    for (name, element) in extras(app, request) { walk(element, name, 0) }
    walk(try root(app, request, "w"), "w", 0)
  }
  return ["nodes": nodes, "truncated": nodes.count >= MAX_NODES]
}

func locate(_ app: AXUIElement, _ request: Request) throws -> Request {
  guard let box = frame(try resolve(app, request)) else { return [:] }
  return ["frame": [box.minX, box.minY, box.width, box.height].map { Double($0) }]
}

func keyEvents(_ request: Request, code: CGKeyCode, flags: UInt64, text units: [UniChar]? = nil) throws {
  for down in [true, false] {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { throw Failure(message: "Could not create a key event") }
    event.flags = CGEventFlags(rawValue: flags)
    if let units = units { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units) }
    if isGlobal(request) { event.post(tap: .cghidEventTap) } else { event.postToPid(try pid(request)) }
  }
}

func typeKeys(_ request: Request, _ value: String) throws {
  for character in value {
    if character.isNewline { try keyEvents(request, code: 36, flags: 0) }
    else if character == "\t" { try keyEvents(request, code: 48, flags: 0) }
    else { try keyEvents(request, code: 0, flags: 0, text: Array(String(character).utf16)) }
    usleep(8000)
  }
}

func type(_ app: AXUIElement, _ request: Request) throws -> Request {
  guard let value = request["text"] as? String else { throw Failure(message: "Missing text") }
  let focused = request["ref"] is String ? try resolve(app, request) : attribute(app, "AXFocusedUIElement").map { $0 as! AXUIElement }
  if let element = focused {
    if settable(element, "AXFocused") { AXUIElementSetAttributeValue(element, "AXFocused" as CFString, kCFBooleanTrue) }
    if settable(element, "AXSelectedText"), AXUIElementSetAttributeValue(element, "AXSelectedText" as CFString, value as CFString) == .success {
      return ["done": "Typed into \(summary(element))"]
    }
  }
  try typeKeys(request, value)
  return ["done": "Typed as key events"]
}

func setValue(_ app: AXUIElement, _ request: Request) throws -> Request {
  let element = try resolve(app, request)
  guard let value = request["text"] as? String else { throw Failure(message: "Missing text") }
  guard settable(element, "AXValue") else { throw Failure(message: "\(summary(element)) has no value that can be set.") }
  let status = AXUIElementSetAttributeValue(element, "AXValue" as CFString, value as CFString)
  guard status == .success else { throw Failure(message: "\(summary(element)) refused the value (\(status.rawValue)).") }
  return ["done": "Set the value of \(summary(element))"]
}

/** Moves the scroll bar of the nearest scroll area, by a share of the content. */
func scroll(_ app: AXUIElement, _ request: Request) throws -> Request {
  // A wheel event works where there is a point, and on views without a scroll bar.
  if let x = (request["pointX"] as? NSNumber)?.doubleValue, let y = (request["pointY"] as? NSNumber)?.doubleValue {
    let point = CGPoint(x: x, y: y)
    let pixels = Int32(try number(request, "delta") * -2000)
    let horizontal = (request["horizontal"] as? Bool) == true
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: horizontal ? 0 : pixels, wheel2: horizontal ? pixels : 0, wheel3: 0) else { throw Failure(message: "Could not create a scroll event") }
    event.location = point
    if isGlobal(request) {
      try requireOnTop(point, request)
      try glide(request, to: point, flags: 0)
      usleep(30_000)
      event.post(tap: .cghidEventTap)
    } else {
      try address(event, request, point)
      event.postToPid(try pid(request))
    }
    return ["done": "Scrolled"]
  }
  let start = try target(app, request)
  let delta = try number(request, "delta")
  let name = (request["horizontal"] as? Bool) == true ? "AXHorizontalScrollBar" : "AXVerticalScrollBar"
  for element in ancestors(start) {
    let holder = text(element, "AXRole") == "AXScrollArea" ? element : attribute(element, "AXParent").map { $0 as! AXUIElement } ?? element
    guard let bar = attribute(holder, name) else { continue }
    let handle = bar as! AXUIElement
    guard let current = attribute(handle, "AXValue") as? NSNumber else { continue }
    let next = min(1, max(0, current.doubleValue + delta))
    if AXUIElementSetAttributeValue(handle, "AXValue" as CFString, next as CFNumber) == .success {
      return ["done": "Scrolled to \(Int(next * 100))%"]
    }
  }
  throw Failure(message: "No scroll bar found there. Try Page Down, or scroll with a ref inside the list.")
}

func windows() -> Request {
  let rows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  let list: [Request] = rows.compactMap { row in
    // Alerts and panels sit above the normal layer, up to the modal panel level.
    guard let layer = row[kCGWindowLayer as String] as? Int, layer >= 0, layer <= 8, let bounds = row[kCGWindowBounds as String] as? [String: Double] else { return nil }
    return [
      "layer": layer,
      "id": row[kCGWindowNumber as String] ?? 0,
      "pid": row[kCGWindowOwnerPID as String] ?? 0,
      "app": row[kCGWindowOwnerName as String] ?? "",
      "title": row[kCGWindowName as String] ?? "",
      "x": bounds["X"] ?? 0,
      "y": bounds["Y"] ?? 0,
      "width": bounds["Width"] ?? 0,
      "height": bounds["Height"] ?? 0
    ]
  }
  return ["windows": list]
}

/** A short mark of what the window, or with full control the desktop, shows now. */
func state(_ request: Request) throws -> Request {
  var content: String
  if isGlobal(request) {
    let rows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    content = rows.filter { ($0[kCGWindowLayer as String] as? Int) == 0 }.map { "\($0[kCGWindowNumber as String] ?? 0) \($0[kCGWindowBounds as String] ?? 0)" }.joined(separator: "\n")
  } else {
    let app = try application(request)
    content = signature(try windowElement(app, request)) + extras(app, request).map { summary($0.1) }.joined()
  }
  var mark: UInt64 = 0xcbf29ce484222325
  for byte in content.utf8 { mark = (mark ^ UInt64(byte)) &* 0x100000001b3 }
  return ["state": String(mark, radix: 16)]
}

func handle(_ request: Request) throws -> Request {
  switch request["op"] as? String {
  case "windows": return windows()
  case "state": return try state(request)
  case "raise":
    try bringForward(try application(request), request)
    return ["done": "Raised"]
  case "frame": return try locate(try application(request), request)
  case "tree": return try tree(try application(request), request)
  case "click": return try click(try application(request), request)
  case "pointer":
    let app = try application(request)
    if (request["kind"] as? String) == "move" { return try pointer(app, request) }
    var reply = try pointer(app, request)
    if !isGlobal(request) { reply["dialogs"] = openDialogs(app, request) }
    return reply
  case "type":
    if isGlobal(request) {
      guard let value = request["text"] as? String else { throw Failure(message: "Missing text") }
      try typeKeys(request, value)
      return ["done": "Typed"]
    }
    return try type(try application(request), request)
  case "set_value": return try setValue(try application(request), request)
  case "scroll": return try scroll(try application(request), request)
  case "key":
    try keyEvents(request, code: CGKeyCode(try number(request, "code")), flags: UInt64(try number(request, "flags")))
    if isGlobal(request) { return ["done": "Sent"] }
    return ["done": "Sent", "dialogs": openDialogs(try application(request), request)]
  default: throw Failure(message: "Unknown op")
  }
}

/** Hides the real cursor until killed, for the overlay to draw the Galaxy cursor in its place. If the app dies this process ends too, and macOS shows the cursor again. */
func hideCursor() -> Never {
  let graphics = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW)
  if let connection = dlsym(graphics, "_CGSDefaultConnection"), let property = dlsym(graphics, "CGSSetConnectionProperty") {
    let id = unsafeBitCast(connection, to: (@convention(c) () -> Int32).self)()
    // Without this, only the frontmost app may hide the cursor.
    _ = unsafeBitCast(property, to: (@convention(c) (Int32, Int32, CFString, CFTypeRef) -> Int32).self)(id, id, "SetsCursorInBackground" as CFString, kCFBooleanTrue)
  }
  let application = NSApplication.shared
  application.setActivationPolicy(.accessory)
  let parent = getppid()
  // macOS shows the cursor again when other apps change it, so keep hiding it.
  Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
    if getppid() != parent { exit(0) }
    var count: UInt32 = 0
    var displays = [CGDirectDisplayID](repeating: 0, count: 16)
    CGGetOnlineDisplayList(16, &displays, &count)
    for display in displays.prefix(Int(count)) { CGDisplayHideCursor(display) }
  }
  application.run()
  exit(0)
}

if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "hide-cursor" { hideCursor() }

// An action that opens a modal alert does not answer until the alert closes, so do not wait on it for long.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 2)

var reply: Request
do {
  guard CommandLine.arguments.count > 1, let data = CommandLine.arguments[1].data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? Request else {
    throw Failure(message: "Expected a JSON request")
  }
  reply = try handle(request)
} catch let failure as Failure {
  reply = ["error": failure.message]
} catch {
  reply = ["error": String(describing: error)]
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: reply))
