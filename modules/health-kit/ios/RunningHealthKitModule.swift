// Native HealthKit bridge for Running OS.
//
// HealthKit has no server API — health data lives on-device in an encrypted
// store that only the user's own device can read. Everything the app knows
// from Apple Health therefore comes through this module and is pushed up to
// the backend's ingest endpoint. That is a platform constraint, not a design
// choice, and the architecture reflects it rather than pretending otherwise.
//
// Two rules shape the code below:
//
//   1. Never assume a type is available or authorised. HealthKit is absent on
//      iPad and Mac, individual permissions can be denied one by one, and
//      several running metrics only exist on newer watchOS/iOS releases.
//      Every read degrades to "no data" instead of throwing.
//
//   2. Never infer denial from emptiness. `authorizationStatus(for:)`
//      deliberately never reveals read permission — Apple treats that as
//      privacy-sensitive, because knowing a query returned nothing would leak
//      that the user has no data of that kind. An empty result means
//      "nothing to report", never "the user said no".

import ExpoModulesCore
import HealthKit

// MARK: - Availability

/// Running metrics introduced after the module's minimum deployment target.
/// Guarded individually so an older OS simply reports fewer metrics.
private enum RunningMetric {
  static var runningSpeed: HKQuantityType? {
    if #available(iOS 16.0, *) { return HKQuantityType(.runningSpeed) }
    return nil
  }
  static var runningPower: HKQuantityType? {
    if #available(iOS 16.0, *) { return HKQuantityType(.runningPower) }
    return nil
  }
  static var strideLength: HKQuantityType? {
    if #available(iOS 16.0, *) { return HKQuantityType(.runningStrideLength) }
    return nil
  }
  static var verticalOscillation: HKQuantityType? {
    if #available(iOS 16.0, *) { return HKQuantityType(.runningVerticalOscillation) }
    return nil
  }
  static var groundContactTime: HKQuantityType? {
    if #available(iOS 16.0, *) { return HKQuantityType(.runningGroundContactTime) }
    return nil
  }
}

public class RunningHealthKitModule: Module {
  private let store = HKHealthStore()

  public func definition() -> ModuleDefinition {
    Name("RunningHealthKit")

    // MARK: Availability

    Function("isAvailable") { () -> Bool in
      HKHealthStore.isHealthDataAvailable()
    }

    // MARK: Authorization

    /// Requests read access to the types the product actually uses.
    ///
    /// Returns `granted: true` when the sheet was presented and dismissed
    /// without error. It deliberately does NOT claim which types were allowed:
    /// iOS does not tell us, and inventing an answer would be worse than
    /// admitting we cannot know.
    AsyncFunction("requestAuthorization") { (promise: Promise) in
      guard HKHealthStore.isHealthDataAvailable() else {
        promise.resolve([
          "granted": false,
          "available": false,
          "reason": "Health data is not available on this device.",
        ])
        return
      }

      let readTypes = Set(self.readTypes())

      self.store.requestAuthorization(toShare: [], read: readTypes) { success, error in
        if let error = error {
          promise.resolve([
            "granted": false,
            "available": true,
            "reason": error.localizedDescription,
          ])
          return
        }
        promise.resolve([
          "granted": success,
          "available": true,
          // Honest about the platform's behaviour rather than guessing.
          "note": "iOS does not disclose which read permissions were granted.",
        ])
      }
    }

    /// Share-permission status only. Included for completeness; the app writes
    /// nothing today, so this is informational.
    Function("authorizationStatusForSharing") { (identifier: String) -> String in
      guard let type = self.quantityType(for: identifier) else { return "notDetermined" }
      switch self.store.authorizationStatus(for: type) {
      case .sharingAuthorized: return "authorized"
      case .sharingDenied: return "denied"
      default: return "notDetermined"
      }
    }

    // MARK: Workouts

    /// Reads workouts in a date range, enriched with distance, heart rate and
    /// energy pulled from the workout's own statistics.
    AsyncFunction("getWorkouts") { (startISO: String, endISO: String, limit: Int, promise: Promise) in
      guard HKHealthStore.isHealthDataAvailable() else {
        promise.resolve([])
        return
      }
      guard let start = Self.parseISO(startISO), let end = Self.parseISO(endISO) else {
        promise.reject("INVALID_DATE", "Start and end must be ISO-8601 strings.")
        return
      }

      let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
      let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)

      let query = HKSampleQuery(
        sampleType: HKObjectType.workoutType(),
        predicate: predicate,
        limit: limit > 0 ? limit : HKObjectQueryNoLimit,
        sortDescriptors: [sort]
      ) { _, samples, error in
        if error != nil {
          // A read failure is indistinguishable from "no permission" by design.
          promise.resolve([])
          return
        }
        guard let workouts = samples as? [HKWorkout] else {
          promise.resolve([])
          return
        }

        let group = DispatchGroup()
        var results: [[String: Any]] = []
        let lock = NSLock()

        for workout in workouts {
          group.enter()
          self.serialize(workout: workout) { payload in
            lock.lock()
            results.append(payload)
            lock.unlock()
            group.leave()
          }
        }

        group.notify(queue: .main) {
          // Restore deterministic ordering after the concurrent enrichment.
          let sorted = results.sorted {
            ($0["startDate"] as? String ?? "") > ($1["startDate"] as? String ?? "")
          }
          promise.resolve(sorted)
        }
      }

      self.store.execute(query)
    }

    /// Heart-rate samples inside a workout, for drift and zone analysis.
    AsyncFunction("getHeartRateSamples") { (startISO: String, endISO: String, promise: Promise) in
      guard let start = Self.parseISO(startISO), let end = Self.parseISO(endISO),
            let type = HKQuantityType.quantityType(forIdentifier: .heartRate) else {
        promise.resolve([])
        return
      }

      let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
      let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
      let unit = HKUnit.count().unitDivided(by: .minute())

      let query = HKSampleQuery(
        sampleType: type,
        predicate: predicate,
        limit: HKObjectQueryNoLimit,
        sortDescriptors: [sort]
      ) { _, samples, _ in
        guard let quantities = samples as? [HKQuantitySample] else {
          promise.resolve([])
          return
        }
        let payload = quantities.map { sample -> [String: Any] in
          [
            "uuid": sample.uuid.uuidString,
            "startDate": Self.formatISO(sample.startDate),
            "endDate": Self.formatISO(sample.endDate),
            "value": sample.quantity.doubleValue(for: unit),
            "unit": "bpm",
            "sourceName": sample.sourceRevision.source.name,
          ]
        }
        promise.resolve(payload)
      }

      self.store.execute(query)
    }

    /// Generic quantity reader for scalar metrics (weight, resting HR, VO2max…).
    AsyncFunction("getQuantitySamples") {
      (identifier: String, startISO: String, endISO: String, limit: Int, promise: Promise) in
      guard let type = self.quantityType(for: identifier),
            let start = Self.parseISO(startISO),
            let end = Self.parseISO(endISO) else {
        promise.resolve([])
        return
      }

      let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
      let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
      let unit = self.preferredUnit(for: identifier)

      let query = HKSampleQuery(
        sampleType: type,
        predicate: predicate,
        limit: limit > 0 ? limit : HKObjectQueryNoLimit,
        sortDescriptors: [sort]
      ) { _, samples, _ in
        guard let quantities = samples as? [HKQuantitySample] else {
          promise.resolve([])
          return
        }
        let payload = quantities.compactMap { sample -> [String: Any]? in
          guard sample.quantity.is(compatibleWith: unit.hkUnit) else { return nil }
          return [
            "uuid": sample.uuid.uuidString,
            "type": identifier,
            "startDate": Self.formatISO(sample.startDate),
            "endDate": Self.formatISO(sample.endDate),
            "value": sample.quantity.doubleValue(for: unit.hkUnit),
            "unit": unit.label,
            "sourceName": sample.sourceRevision.source.name,
          ]
        }
        promise.resolve(payload)
      }

      self.store.execute(query)
    }

    /// The GPS route attached to a workout, when one was recorded.
    AsyncFunction("getWorkoutRoute") { (workoutUUID: String, promise: Promise) in
      guard let uuid = UUID(uuidString: workoutUUID) else {
        promise.resolve([])
        return
      }

      let workoutPredicate = HKQuery.predicateForObject(with: uuid)
      let workoutQuery = HKSampleQuery(
        sampleType: HKObjectType.workoutType(),
        predicate: workoutPredicate,
        limit: 1,
        sortDescriptors: nil
      ) { _, samples, _ in
        guard let workout = samples?.first as? HKWorkout else {
          promise.resolve([])
          return
        }

        let routePredicate = HKQuery.predicateForObjects(from: workout)
        let routeQuery = HKAnchoredObjectQuery(
          type: HKSeriesType.workoutRoute(),
          predicate: routePredicate,
          anchor: nil,
          limit: HKObjectQueryNoLimit
        ) { _, routeSamples, _, _, _ in
          guard let route = routeSamples?.first as? HKWorkoutRoute else {
            promise.resolve([])
            return
          }

          var coordinates: [[String: Any]] = []
          let routeDataQuery = HKWorkoutRouteQuery(route: route) { _, locations, done, _ in
            if let locations = locations {
              for location in locations {
                coordinates.append([
                  "lat": location.coordinate.latitude,
                  "lon": location.coordinate.longitude,
                  "elevationMeters": location.altitude,
                  "timestamp": Self.formatISO(location.timestamp),
                ])
              }
            }
            if done { promise.resolve(coordinates) }
          }
          self.store.execute(routeDataQuery)
        }
        self.store.execute(routeQuery)
      }

      self.store.execute(workoutQuery)
    }

    /// Nightly sleep, collapsed from HealthKit's per-stage category samples.
    AsyncFunction("getSleepSamples") { (startISO: String, endISO: String, promise: Promise) in
      guard let start = Self.parseISO(startISO), let end = Self.parseISO(endISO),
            let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else {
        promise.resolve([])
        return
      }

      let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
      let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)

      let query = HKSampleQuery(
        sampleType: type,
        predicate: predicate,
        limit: HKObjectQueryNoLimit,
        sortDescriptors: [sort]
      ) { _, samples, _ in
        guard let categories = samples as? [HKCategorySample] else {
          promise.resolve([])
          return
        }
        let payload = categories.map { sample -> [String: Any] in
          [
            "uuid": sample.uuid.uuidString,
            "type": "sleep",
            "startDate": Self.formatISO(sample.startDate),
            "endDate": Self.formatISO(sample.endDate),
            "stage": Self.sleepStage(sample.value),
            "value": sample.endDate.timeIntervalSince(sample.startDate),
            "unit": "s",
            "sourceName": sample.sourceRevision.source.name,
          ]
        }
        promise.resolve(payload)
      }

      self.store.execute(query)
    }
  }

  // MARK: - Serialisation

  /// Turn an HKWorkout into the payload the ingest endpoint expects.
  private func serialize(workout: HKWorkout, completion: @escaping ([String: Any]) -> Void) {
    var payload: [String: Any] = [
      "uuid": workout.uuid.uuidString,
      "activityType": Self.activityName(workout.workoutActivityType),
      "startDate": Self.formatISO(workout.startDate),
      "endDate": Self.formatISO(workout.endDate),
      "durationSeconds": workout.duration,
      "sourceName": workout.sourceRevision.source.name,
      // An indoor run has no GPS distance and must not be compared with
      // outdoor runs when computing aerobic efficiency.
      "isIndoor": (workout.metadata?[HKMetadataKeyIndoorWorkout] as? Bool) ?? false,
    ]

    if #available(iOS 16.0, *) {
      // HKWorkout.totalDistance and totalEnergyBurned are deprecated in
      // favour of per-type statistics, which are also more accurate.
      if let distanceType = HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning),
         let stats = workout.statistics(for: distanceType),
         let sum = stats.sumQuantity() {
        payload["distanceMeters"] = sum.doubleValue(for: .meter())
      }
      if let energyType = HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned),
         let stats = workout.statistics(for: energyType),
         let sum = stats.sumQuantity() {
        payload["totalEnergyKcal"] = sum.doubleValue(for: .kilocalorie())
      }
      if let hrType = HKQuantityType.quantityType(forIdentifier: .heartRate),
         let stats = workout.statistics(for: hrType) {
        let unit = HKUnit.count().unitDivided(by: .minute())
        if let average = stats.averageQuantity() {
          payload["avgHeartRateBpm"] = average.doubleValue(for: unit)
        }
        if let maximum = stats.maximumQuantity() {
          payload["maxHeartRateBpm"] = maximum.doubleValue(for: unit)
        }
      }
    } else {
      if let distance = workout.totalDistance {
        payload["distanceMeters"] = distance.doubleValue(for: .meter())
      }
      if let energy = workout.totalEnergyBurned {
        payload["totalEnergyKcal"] = energy.doubleValue(for: .kilocalorie())
      }
    }

    completion(payload)
  }

  // MARK: - Type resolution

  /// The complete read set. Only what the product genuinely uses, so the
  /// permission sheet stays short and honest.
  private func readTypes() -> [HKObjectType] {
    var types: [HKObjectType] = [HKObjectType.workoutType(), HKSeriesType.workoutRoute()]

    let quantityIdentifiers: [HKQuantityTypeIdentifier] = [
      .heartRate,
      .restingHeartRate,
      .heartRateVariabilitySDNN,
      .activeEnergyBurned,
      .distanceWalkingRunning,
      .stepCount,
      .bodyMass,
      .height,
      .vo2Max,
    ]
    for identifier in quantityIdentifiers {
      if let type = HKQuantityType.quantityType(forIdentifier: identifier) {
        types.append(type)
      }
    }

    // Running-form metrics, each present only on supported OS versions.
    for optional in [
      RunningMetric.runningSpeed,
      RunningMetric.runningPower,
      RunningMetric.strideLength,
      RunningMetric.verticalOscillation,
      RunningMetric.groundContactTime,
    ] {
      if let type = optional { types.append(type) }
    }

    if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
      types.append(sleep)
    }

    return types
  }

  private func quantityType(for identifier: String) -> HKQuantityType? {
    switch identifier {
    case "heart_rate": return HKQuantityType.quantityType(forIdentifier: .heartRate)
    case "resting_heart_rate": return HKQuantityType.quantityType(forIdentifier: .restingHeartRate)
    case "hrv": return HKQuantityType.quantityType(forIdentifier: .heartRateVariabilitySDNN)
    case "body_mass": return HKQuantityType.quantityType(forIdentifier: .bodyMass)
    case "height": return HKQuantityType.quantityType(forIdentifier: .height)
    case "vo2_max": return HKQuantityType.quantityType(forIdentifier: .vo2Max)
    case "active_energy": return HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)
    case "step_count": return HKQuantityType.quantityType(forIdentifier: .stepCount)
    case "distance": return HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)
    case "running_speed": return RunningMetric.runningSpeed
    case "running_power": return RunningMetric.runningPower
    case "stride_length": return RunningMetric.strideLength
    case "vertical_oscillation": return RunningMetric.verticalOscillation
    case "ground_contact_time": return RunningMetric.groundContactTime
    default: return nil
    }
  }

  private struct UnitSpec {
    let hkUnit: HKUnit
    let label: String
  }

  /// Canonical units, matching the units the rest of the system stores.
  private func preferredUnit(for identifier: String) -> UnitSpec {
    switch identifier {
    case "heart_rate", "resting_heart_rate":
      return UnitSpec(hkUnit: HKUnit.count().unitDivided(by: .minute()), label: "bpm")
    case "hrv":
      return UnitSpec(hkUnit: .secondUnit(with: .milli), label: "ms")
    case "body_mass":
      return UnitSpec(hkUnit: .gramUnit(with: .kilo), label: "kg")
    case "height", "stride_length", "vertical_oscillation":
      return UnitSpec(hkUnit: .meter(), label: "m")
    case "vo2_max":
      return UnitSpec(
        hkUnit: HKUnit.literUnit(with: .milli)
          .unitDivided(by: HKUnit.gramUnit(with: .kilo).unitMultiplied(by: .minute())),
        label: "ml/kg/min"
      )
    case "active_energy":
      return UnitSpec(hkUnit: .kilocalorie(), label: "kcal")
    case "step_count":
      return UnitSpec(hkUnit: .count(), label: "count")
    case "distance":
      return UnitSpec(hkUnit: .meter(), label: "m")
    case "running_speed":
      return UnitSpec(hkUnit: HKUnit.meter().unitDivided(by: .second()), label: "m/s")
    case "running_power":
      return UnitSpec(hkUnit: .watt(), label: "W")
    case "ground_contact_time":
      return UnitSpec(hkUnit: .secondUnit(with: .milli), label: "ms")
    default:
      return UnitSpec(hkUnit: .count(), label: "count")
    }
  }

  // MARK: - Helpers

  private static let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  private static func formatISO(_ date: Date) -> String {
    isoFormatter.string(from: date)
  }

  private static func parseISO(_ value: String) -> Date? {
    if let date = isoFormatter.date(from: value) { return date }
    // Fall back for timestamps without fractional seconds.
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: value)
  }

  private static func sleepStage(_ value: Int) -> String {
    guard #available(iOS 16.0, *) else {
      return value == HKCategoryValueSleepAnalysis.inBed.rawValue ? "in_bed" : "asleep"
    }
    switch value {
    case HKCategoryValueSleepAnalysis.inBed.rawValue: return "in_bed"
    case HKCategoryValueSleepAnalysis.awake.rawValue: return "awake"
    case HKCategoryValueSleepAnalysis.asleepCore.rawValue: return "core"
    case HKCategoryValueSleepAnalysis.asleepDeep.rawValue: return "deep"
    case HKCategoryValueSleepAnalysis.asleepREM.rawValue: return "rem"
    case HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue: return "asleep"
    default: return "unknown"
    }
  }

  private static func activityName(_ type: HKWorkoutActivityType) -> String {
    switch type {
    case .running: return "running"
    case .walking: return "walking"
    case .hiking: return "hiking"
    case .cycling: return "cycling"
    case .swimming: return "swimming"
    case .traditionalStrengthTraining, .functionalStrengthTraining: return "strength_training"
    case .highIntensityIntervalTraining: return "hiit"
    case .elliptical: return "elliptical"
    case .rowing: return "rowing"
    case .yoga: return "yoga"
    default: return "other"
    }
  }
}
