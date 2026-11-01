// Works in other apps' windows without touching the user's pointer or keyboard focus.
// Takes one JSON request as its argument and prints one JSON reply.
//
// Clicks go through the accessibility API, by ref or by point, or are posted to the window in place,
// which leaves the user's pointer and keyboard focus alone. Events only reach a window that is not
// under the pointer when they name it, which takes the private field and call below. Pages and many
// controls also ignore clicks unless their app is active and the window key, so a step can tell the
// app so without the real front app changing.
// With full control, requests marked global act on the whole screen with the real pointer and keyboard.
// Run with the argument hide-cursor, it hides the real cursor until it is killed.
// Run with the arguments stream and a window number, it writes that window's picture to stdout until it is killed.

import AppKit
import ApplicationServices
import CoreImage
import ScreenCaptureKit

struct Failure: Error {
  let message: String
}

typealias Request = [String: Any]

let MAX_NODES = 500
let ICON_SIZE = 64
let STREAM_WIDTH = 640
let STREAM_FRAME_RATE: CMTimeScale = 12
let STREAM_QUALITY = 0.6
/** The event field AppKit reads a window number from. */
let WINDOW_FIELD = CGEventField(rawValue: 51)!
let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
let setWindowLocation: (@convention(c) (CGEvent, CGPoint) -> Void)? = skyLight
  .flatMap { dlsym($0, "CGEventSetWindowLocation") }
  .map { unsafeBitCast($0, to: (@convention(c) (CGEvent, CGPoint) -> Void).self) }
let postEventRecord: (@convention(c) (UnsafePointer<ProcessSerialNumber>, UnsafePointer<UInt8>) -> Int32)? = skyLight
  .flatMap { dlsym($0, "SLPSPostEventRecordTo") }
  .map { unsafeBitCast($0, to: (@convention(c) (UnsafePointer<ProcessSerialNumber>, UnsafePointer<UInt8>) -> Int32).self) }
let processForPid: (@convention(c) (pid_t, UnsafeMutablePointer<ProcessSerialNumber>) -> Int32)? = dlopen(nil, RTLD_NOW)
  .flatMap { dlsym($0, "GetProcessForPID") }
  .map { unsafeBitCast($0, to: (@convention(c) (pid_t, UnsafeMutablePointer<ProcessSerialNumber>) -> Int32).self) }
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

/** Whether an element is on a web page or holds one. Chromium answers for a point with the scroll area around its page. */
func holdsPage(_ element: AXUIElement) -> Bool {
  if webArea(element) != nil { return true }
  var pending = children(element)
  for _ in 0..<30 {
    guard !pending.isEmpty else { break }
    let next = pending.removeFirst()
    if text(next, "AXRole") == "AXWebArea" { return true }
    pending += children(next)
  }
  return false
}

/** Whether an element comes to differ from an earlier signature. Pages and slow apps show a click late, so this keeps looking until `limit` seconds have passed. */
func showsChange(_ element: AXUIElement, from before: String?, within limit: TimeInterval) -> Bool {
  let end = Date().addingTimeInterval(limit)
  repeat {
    usleep(150_000)
    if signature(element) != before { return true }
  } while Date() < end
  return false
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

/** The window a click lands in: the alert or dialog the service found at the point, or else the target. */
func clickedWindow(_ request: Request) throws -> (id: Int64, frame: CGRect) {
  if let hit = request["hit"] as? [Double], hit.count == 5 { return (Int64(hit[0]), CGRect(x: hit[1], y: hit[2], width: hit[3], height: hit[4])) }
  return (Int64(try number(request, "windowId")), CGRect(x: try number(request, "x"), y: try number(request, "y"), width: try number(request, "width"), height: try number(request, "height")))
}

/** Where to click an element: the middle of its frame, or of the part inside the window. */
func clickPoint(_ app: AXUIElement, _ element: AXUIElement, _ request: Request) -> CGPoint? {
  if let x = (request["pointX"] as? NSNumber)?.doubleValue, let y = (request["pointY"] as? NSNumber)?.doubleValue { return CGPoint(x: x, y: y) }
  return visiblePart(element, request).map { CGPoint(x: $0.midX, y: $0.midY) }
}

/** The part of an element a click can reach: inside the window and inside every scroll area around it. */
func visiblePart(_ element: AXUIElement, _ request: Request) -> CGRect? {
  guard let box = frame(element), let window = try? clickedWindow(request) else { return nil }
  var visible = box.intersection(window.frame)
  var current = element
  for _ in 0..<40 {
    guard let parent = attribute(current, "AXParent") else { break }
    current = parent as! AXUIElement
    let role = text(current, "AXRole")
    if role == "AXWindow" { break }
    if role == "AXScrollArea", let clip = frame(current) { visible = visible.intersection(clip) }
  }
  return visible.isNull || visible.isEmpty ? nil : visible
}

func scrollArea(around element: AXUIElement) -> AXUIElement? {
  var current = element
  for _ in 0..<40 {
    guard let parent = attribute(current, "AXParent") else { return nil }
    current = parent as! AXUIElement
    if text(current, "AXRole") == "AXScrollArea" { return current }
  }
  return nil
}

/** Narrows in on an element with a scroll bar. Content length is unknown, so it halves the range of the bar each time. */
func scrollBar(_ element: AXUIElement, of area: AXUIElement, _ request: Request, horizontal: Bool) -> Bool {
  guard let found = attribute(area, horizontal ? "AXHorizontalScrollBar" : "AXVerticalScrollBar"), let clip = frame(area) else { return false }
  let bar = found as! AXUIElement
  var low = 0.0
  var high = 1.0
  for _ in 0..<12 {
    guard let box = frame(element), let value = (attribute(bar, "AXValue") as? NSNumber)?.doubleValue else { return false }
    let past = horizontal ? box.midX > clip.maxX : box.midY > clip.maxY
    if past { low = value } else { high = value }
    guard AXUIElementSetAttributeValue(bar, "AXValue" as CFString, ((low + high) / 2) as CFNumber) == .success else { return false }
    usleep(80_000)
    if visiblePart(element, request) != nil { return true }
  }
  return false
}

/** Scrolls with the wheel, for views without a scroll bar. */
func scrollWheel(_ element: AXUIElement, in area: AXUIElement, _ request: Request) throws -> Bool {
  guard let clip = frame(area) else { return false }
  let point = CGPoint(x: clip.midX, y: clip.midY)
  for _ in 0..<12 {
    guard let box = frame(element) else { return false }
    let down = max(-clip.height * 0.8, min(clip.height * 0.8, box.midY - clip.midY))
    let across = max(-clip.width * 0.8, min(clip.width * 0.8, box.midX - clip.midX))
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(-down), wheel2: Int32(-across), wheel3: 0) else { return false }
    event.location = point
    try address(event, request, point)
    event.postToPid(try pid(request))
    usleep(120_000)
    if visiblePart(element, request) != nil { return true }
  }
  return false
}

/** Brings an element that is scrolled away back into view, the way the app offers first. */
func reveal(_ element: AXUIElement, _ request: Request) -> Bool {
  if visiblePart(element, request) != nil { return true }
  for candidate in ancestors(element) where actions(candidate).contains("AXScrollToVisible") {
    _ = perform(candidate, "AXScrollToVisible")
    usleep(150_000)
    if visiblePart(element, request) != nil { return true }
  }
  guard let area = scrollArea(around: element), frame(element) != nil else { return false }
  if scrollBar(element, of: area, request, horizontal: false) || scrollBar(element, of: area, request, horizontal: true) { return true }
  return (try? scrollWheel(element, in: area, request)) == true
}

/** Something of the element that can be clicked in its place when it has no visible frame of its own: what is inside it, or the row around it. */
func standIn(for element: AXUIElement, _ request: Request) -> AXUIElement? {
  var pending = children(element)
  for _ in 0..<40 {
    guard !pending.isEmpty else { break }
    let next = pending.removeFirst()
    if visiblePart(next, request) != nil { return next }
    pending += children(next)
  }
  return ancestors(element).dropFirst().first { ["AXCell", "AXRow"].contains(text($0, "AXRole")) && visiblePart($0, request) != nil }
}

/** What can still be done for an element that cannot be clicked at a point: press something inside it, or select it or its row. */
func actWithoutPoint(_ start: AXUIElement, wanted: [String]) -> String? {
  var pending = children(start)
  for _ in 0..<40 {
    guard !pending.isEmpty else { break }
    let next = pending.removeFirst()
    for action in wanted where actions(next).contains(action) {
      let name = summary(next)
      if perform(next, action) { return "\(action) on \(name)" }
    }
    pending += children(next)
  }
  for element in ancestors(start) where settable(element, "AXSelected") {
    let name = summary(element)
    if AXUIElementSetAttributeValue(element, "AXSelected" as CFString, kCFBooleanTrue) == .success { return "Selected \(name)" }
  }
  return nil
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
  if let done = pressed, dialogs.isEmpty, let page = page, showsChange(page, from: before, within: 1) {
    return ["done": done, "dialogs": dialogs]
  }
  if let done = pressed, page == nil || !dialogs.isEmpty { return ["done": done, "dialogs": dialogs] }
  // An element scrolled away is brought back first. A click at the agent's own point already says where to go.
  let atPoint = request["pointX"] != nil
  let moved = !atPoint && visiblePart(start, request) == nil
  if moved { _ = reveal(start, request) }
  guard let point = clickPoint(app, start, request) ?? standIn(for: start, request).flatMap({ clickPoint(app, $0, request) }) else {
    if let done = pressed { return ["done": done, "dialogs": dialogs, "unchanged": true] }
    if let done = actWithoutPoint(start, wanted: wanted) { return ["done": done, "dialogs": openDialogs(app, request)] }
    throw Failure(message: "\(summary(start)) could not be scrolled into view, and nothing inside it can be pressed or selected.")
  }
  // Normal apps show a click in their tree too, so a click in place is checked against the window.
  let scope = page ?? (try? windowElement(app, request))
  let earlier = page == nil || moved ? scope.map(signature) : before
  // Closing an alert changes nothing in the window behind it.
  let hadDialogs = !extras(app, request).isEmpty
  if settable(start, "AXFocused") { AXUIElementSetAttributeValue(start, "AXFocused" as CFString, kCFBooleanTrue) }
  try clickInPlace(request, point, kind: kind)
  dialogs = openDialogs(app, request)
  var reply: Request = ["done": "Clicked \(summary(start)) in place", "dialogs": dialogs]
  if let scope = scope, dialogs.isEmpty, !hadDialogs, !showsChange(scope, from: earlier, within: 1.5) { reply["unchanged"] = true }
  return reply
}

/** Sets what an event needs so that AppKit hands it to the window instead of dropping it. */
func address(_ event: CGEvent, _ request: Request, _ point: CGPoint) throws {
  let window = try clickedWindow(request)
  event.setIntegerValueField(WINDOW_FIELD, value: window.id)
  event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: window.id)
  event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: window.id)
  setWindowLocation?(event, CGPoint(x: point.x - window.frame.minX, y: point.y - window.frame.minY))
}

/** Posts a mouse event to the window, which leaves the real pointer where it is. */
func postInPlace(_ request: Request, _ type: CGEventType, _ point: CGPoint, button: CGMouseButton = .left, clicks: Int64 = 0, flags: UInt64 = 0) throws {
  guard let event = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw Failure(message: "Could not create a mouse event") }
  if clicks > 0 { event.setIntegerValueField(.mouseEventClickState, value: clicks) }
  event.setDoubleValueField(.mouseEventPressure, value: [CGEventType.leftMouseUp, .rightMouseUp, .mouseMoved].contains(type) ? 0 : 1)
  event.flags = CGEventFlags(rawValue: flags)
  try address(event, request, point)
  event.postToPid(try pid(request))
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

/** Makes the app active, which leaves its windows in their order and its open menus and dialogs as they are. */
func activate(_ app: AXUIElement) throws {
  AXUIElementSetAttributeValue(app, "AXFrontmost" as CFString, kCFBooleanTrue)
  for _ in 0..<50 where (attribute(app, "AXFrontmost") as? Bool) != true { usleep(10_000) }
  guard (attribute(app, "AXFrontmost") as? Bool) == true else { throw Failure(message: "The app could not be brought to the front") }
}

/** Brings the target window forward for the real pointer, and stops if it did not come. */
func bringForward(_ app: AXUIElement, _ request: Request) throws {
  try activate(app)
  if let window = try? windowElement(app, request) { AXUIElementPerformAction(window, "AXRaise" as CFString) }
  usleep(150_000)
}

/** Tells an app, with AppKit's own event, whether it is active. The real front app keeps its place and the keyboard. */
func postActivation(_ request: Request, _ subtype: NSEvent.EventSubtype) throws {
  guard let event = NSEvent.otherEvent(with: .appKitDefined, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: Int(try clickedWindow(request).id), context: nil, subtype: subtype.rawValue, data1: 0, data2: 0), let posted = event.cgEvent else { throw Failure(message: "Could not create an activation event") }
  posted.postToPid(try pid(request))
}

/** Makes a window key in its app without moving it. A click on a window that is not key only makes it key, so what is under the click never gets it. */
func makeKey(_ request: Request) throws {
  guard let post = postEventRecord, let lookup = processForPid else { return }
  var process = ProcessSerialNumber()
  guard lookup(try pid(request), &process) == 0 else { return }
  var record = [UInt8](repeating: 0, count: 0xf8)
  record[0x04] = 0xf8
  record[0x3a] = 0x10
  var id = UInt32(try clickedWindow(request).id)
  withUnsafeBytes(of: &id) { bytes in for (offset, byte) in bytes.enumerated() { record[0x3c + offset] = byte } }
  for offset in 0x20..<0x30 { record[offset] = 0xff }
  for phase: UInt8 in [1, 2] {
    record[0x08] = phase
    _ = post(&process, &record)
  }
}

/** Whether the system has the app in front. */
func isReallyFront(_ request: Request) throws -> Bool {
  return NSWorkspace.shared.frontmostApplication?.processIdentifier == (try pid(request))
}

/** Has a background app act as if it were in front until `unfocus`. An app really in front needs none of this. Telling an app again makes it redraw as if it had just become active, so `front` says which app was in front the last time, and only a change of front app, which can end this, repeats it. Answers with the app in front now. */
func focusInPlace(_ request: Request) throws -> Request {
  let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
  let reply: Request = ["done": "Focused", "front": front]
  if try isReallyFront(request) || (request["front"] as? NSNumber)?.int32Value == front { return reply }
  try postActivation(request, .applicationActivated)
  usleep(100_000)
  try makeKey(request)
  usleep(100_000)
  return reply
}

/** Ends `focus`, unless the app came to the front since. */
func unfocusInPlace(_ request: Request) throws {
  if try isReallyFront(request) { return }
  try postActivation(request, .applicationDeactivated)
  // A posted event is lost if the process ends right away.
  usleep(100_000)
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
  // In the background the gesture goes to the window, whatever covers it, and the real pointer stays out of it.
  let background = (request["background"] as? Bool) == true
  let post = background ? postInPlace : postMouse
  // Pages drop a posted move, since the real pointer is elsewhere, but take a drag with no button down as one. Native views could act on that, so only pages get it.
  var element: AXUIElement?
  let onPage = background && AXUIElementCopyElementAtPosition(app, Float(first.x), Float(first.y), &element) == .success && element.map(holdsPage) == true
  let hover: CGEventType = onPage ? .leftMouseDragged : .mouseMoved
  /** Small steps, so that apps which sample the pointer draw a line and not dots. */
  func walk(_ type: CGEventType, clicks: Int64) throws {
    var previous = first
    for point in points.dropFirst() {
      let steps = max(1, Int(hypot(point.x - previous.x, point.y - previous.y) / 6))
      for step in 1...steps {
        let share = CGFloat(step) / CGFloat(steps)
        try post(request, type, CGPoint(x: previous.x + (point.x - previous.x) * share, y: previous.y + (point.y - previous.y) * share), button, clicks, flags)
        usleep(8_000)
      }
      previous = point
    }
  }
  if background {
    try post(request, hover, first, .left, 0, flags)
  } else {
    if !isGlobal(request) { try bringForward(app, request) }
    for point in points { try requireOnTop(point, request) }
    try glide(request, to: first, flags: flags)
  }
  usleep(20_000)
  switch request["kind"] as? String {
  case "move":
    if background {
      try walk(hover, clicks: 0)
    } else {
      for point in points.dropFirst() { try glide(request, to: point, flags: flags) }
    }
    return ["done": "Moved"]
  case "drag":
    try post(request, down, first, button, 1, flags)
    usleep(40_000)
    try walk(dragged, clicks: 1)
    usleep(40_000)
    try post(request, up, last, button, 1, flags)
    return ["done": "Dragged"]
  default:
    let count = max(1, Int64((request["count"] as? NSNumber)?.intValue ?? 1))
    for click in 1...count {
      try post(request, down, first, button, click, flags)
      usleep(20_000)
      try post(request, up, first, button, click, flags)
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

/** An icon drawn large as a PNG, for the app to show smaller, so that every icon comes out equally sharp. */
func iconPng(_ icon: NSImage) -> String? {
  guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: ICON_SIZE, pixelsHigh: ICON_SIZE, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
  NSGraphicsContext.current?.imageInterpolation = .high
  icon.draw(in: NSRect(x: 0, y: 0, width: ICON_SIZE, height: ICON_SIZE))
  NSGraphicsContext.restoreGraphicsState()
  return bitmap.representation(using: .png, properties: [:])?.base64EncodedString()
}

/** A running app's icon. */
func appIcon(_ request: Request) throws -> Request {
  guard let icon = NSRunningApplication(processIdentifier: try pid(request))?.icon, let png = iconPng(icon) else { throw Failure(message: "The app has no icon") }
  return ["icon": png]
}

/** The icons of apps on disk, in the order of `paths`. */
func fileIcons(_ request: Request) -> Request {
  let paths = (request["paths"] as? [String]) ?? []
  // Safari and a few others are links in /Applications, whose icon carries the shortcut arrow.
  return ["icons": paths.map { iconPng(NSWorkspace.shared.icon(forFile: URL(fileURLWithPath: $0).resolvingSymlinksInPath().path)) ?? "" }]
}

func handle(_ request: Request) throws -> Request {
  switch request["op"] as? String {
  case "icon": return try appIcon(request)
  case "fileIcons": return fileIcons(request)
  case "windows": return windows()
  case "state": return try state(request)
  case "raise":
    try bringForward(try application(request), request)
    return ["done": "Raised"]
  case "bringForward":
    // Raising a window of the app already in front could close its open menu or cover its dialog.
    if try !isReallyFront(request) { try bringForward(try application(request), request) }
    return ["done": "In front"]
  case "focus":
    return try focusInPlace(request)
  case "unfocus":
    try unfocusInPlace(request)
    return ["done": "Unfocused"]
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

/** Writes each new picture of a window as a JPEG after its length. */
@available(macOS 12.3, *)
final class WindowStream: NSObject, SCStreamOutput, SCStreamDelegate {
  let context = CIContext()

  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    // A frame with no change holds no image.
    guard type == .screen, let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
    let options = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): STREAM_QUALITY]
    let image = CIImage(cvPixelBuffer: pixels)
    let scale = min(1, CGFloat(STREAM_WIDTH) / image.extent.width)
    guard let jpeg = context.jpegRepresentation(of: image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)), colorSpace: CGColorSpaceCreateDeviceRGB(), options: options) else { return }
    var length = UInt32(jpeg.count).bigEndian
    FileHandle.standardOutput.write(Data(bytes: &length, count: 4))
    FileHandle.standardOutput.write(jpeg)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) { exit(0) }
}

/** Chromium's capture always draws the user's cursor over a window. This one leaves it out. */
@available(macOS 12.3, *)
func streamWindow(_ id: CGWindowID) -> Never {
  let output = WindowStream()
  let parent = getppid()
  Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in if getppid() != parent { exit(0) } }
  var running: SCStream?
  Task {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
      guard let window = content.windows.first(where: { $0.windowID == id }) else { exit(1) }
      let config = SCStreamConfiguration()
      config.showsCursor = false
      // The stream crops to this size rather than scaling, so it takes the whole window and each frame is scaled down.
      let density = NSScreen.main?.backingScaleFactor ?? 2
      config.width = max(1, Int(window.frame.width * density))
      config.height = max(1, Int(window.frame.height * density))
      config.minimumFrameInterval = CMTime(value: 1, timescale: STREAM_FRAME_RATE)
      config.queueDepth = 3
      let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: output)
      try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "stream"))
      try await stream.startCapture()
      running = stream
    } catch {
      exit(1)
    }
  }
  _ = running
  RunLoop.main.run()
  exit(0)
}

if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "hide-cursor" { hideCursor() }
if CommandLine.arguments.count > 2, CommandLine.arguments[1] == "stream", let id = CGWindowID(CommandLine.arguments[2]) {
  guard #available(macOS 12.3, *) else { exit(1) }
  streamWindow(id)
}

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
