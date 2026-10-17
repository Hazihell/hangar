// Prints the Mac's CPU temperature in °C: the hottest of the chip's `tdie` sensors, from IOKit's HID event system (no sudo).
// Prints nothing and exits 1 when there is none. Built by `hangar setup`: swiftc -O temps.swift -o temps
import Foundation
import IOKit
typealias Client = OpaquePointer
@_silgen_name("IOHIDEventSystemClientCreate") func IOHIDEventSystemClientCreate(_ a: CFAllocator?) -> Client
@_silgen_name("IOHIDEventSystemClientSetMatching") func IOHIDEventSystemClientSetMatching(_ c: Client, _ m: CFDictionary) -> Int32
@_silgen_name("IOHIDEventSystemClientCopyServices") func IOHIDEventSystemClientCopyServices(_ c: Client) -> CFArray?
@_silgen_name("IOHIDServiceClientCopyProperty") func IOHIDServiceClientCopyProperty(_ s: OpaquePointer, _ k: CFString) -> CFTypeRef?
@_silgen_name("IOHIDServiceClientCopyEvent") func IOHIDServiceClientCopyEvent(_ s: OpaquePointer, _ t: Int64, _ a: Int32, _ b: Int64) -> OpaquePointer?
@_silgen_name("IOHIDEventGetFloatValue") func IOHIDEventGetFloatValue(_ e: OpaquePointer, _ f: Int32) -> Double
let c = IOHIDEventSystemClientCreate(kCFAllocatorDefault)
_ = IOHIDEventSystemClientSetMatching(c, ["PrimaryUsagePage": 0xff00, "PrimaryUsage": 5] as CFDictionary)
let services = IOHIDEventSystemClientCopyServices(c) as? [AnyObject] ?? []
var hottest: Double?
for s in services {
  let p = unsafeBitCast(s, to: OpaquePointer.self)
  let name = IOHIDServiceClientCopyProperty(p, "Product" as CFString) as? String ?? ""
  // PMU tdev* and the rest are not the chip; some read junk such as -21.
  guard name.range(of: "^PMU2? tdie[0-9]+$", options: .regularExpression) != nil else { continue }
  if let e = IOHIDServiceClientCopyEvent(p, 15, 0, 0) {
    let value = IOHIDEventGetFloatValue(e, 15 << 16)
    if value >= 0 && value <= 150 && value > (hottest ?? -1) { hottest = value }
  }
}
guard let temperature = hottest else { exit(1) }
print(String(format: "%.1f", temperature))
