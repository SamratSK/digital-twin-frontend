# Synthverse Backend API Documentation

Welcome to the Synthverse backend documentation. This application is powered by a modular Flask system consisting of different integrated components (Floorplan node tracking, live event reporting via Twilio, and localized facility assessment via Overpass). 

---

## 1. Floorplan & Sensor APIs (Root Map)

These endpoints provide metadata about physical floorplan nodes (Exits, Lifts, and Hallways) and simulated real-time congestion sensors.

### `GET /api/nodes`
Returns the combined nodes available on the floorplan.
* **Method:** `GET`
* **Response format:**
  ```json
  {
    "exits": [
      { "id": "exit_1", "label": "Exit (Near Lab)", "x": 58.8, "y": 8.5 },
      { "id": "lift_1", "label": "Lift-01", "x": 18.5, "y": 83.8 }
    ],
    "hallway": [
      { "id": "node_entrance", "label": "Entrance", "x": 36.2, "y": 89.2 }
    ]
  }
  ```

### `GET /api/sensors`
Simulates live sensor scores mapping between 0-100 indicating congestion or blockage. Guaranteed to leave at least one exit accessible (<100).
* **Method:** `GET`
* **Response format:**
  ```json
  {
    "hallway": [
      { "id": "node_entrance", "score": 42 }
    ],
    "exits": [
      { "id": "exit_1", "score": 100 },
      { "id": "lift_1", "score": 14 }
    ]
  }
  ```

---

## 2. Event & Traffic Review APIs (`traffic.py`)

Handles crowdsourced incident reporting via WhatsApp (Twilio webhook), dynamic traffic score generation algorithm, and an approval pipeline.

### `POST /api/whatsapp/webhook`
Twilio webhook endpoint that receives messages directly from SMS/WhatsApp to register events to a "pending" queue.
* **Method:** `POST`
* **Expected payload:** Standard `application/x-www-form-urlencoded` from Twilio `Body`. 
  * *Required format:* `<EventName> <Location_Pincode> <YYYY-MM-DD> <ExpectedCrowd>`

### `GET /api/user_events`
Fetches all currently "pending" events awaiting admin review.
* **Method:** `GET`
* **Response format:**
  ```json
  {
    "status": "success",
    "route_type": "pending_events",
    "data": [
      {
        "id": 1,
        "event_name": "TechFest",
        "location": "560070",
        "date": "2026-05-10",
        "expected_crowd": 2000,
        "traffic_score": 45,
        "created_at": "2026-04-04 12:00:00"
      }
    ]
  }
  ```

### `POST /api/user_events/<id>/approve`
Approves a pending event, pushing it live to the global event tracker.
* **Method:** `POST`
* **Request Payload (JSON):**
  ```json
  {
    "status": "approved"
  }
  ```
* **Response format:**
  ```json
  {
    "status": "success",
    "message": "Event approved"
  }
  ```

### `GET /api/events`
Returns all globally approved user events.
* **Method:** `GET`
* **Response format:**
  ```json
  {
    "status": "success",
    "route_type": "approved_events",
    "data": {
      "events": [
        {
          "id": 1,
          "event_name": "TechFest",
          "date": "2026-05-10",
          "venue_type": "560070",
          "expected_crowd": 2000,
          "traffic_score": 45
        }
      ]
    }
  }
  ```

---

## 3. Layer 3 Emergency Resources APIs (`layer_3.py`)

Queries the live Overpass API (OpenStreetMap) utilizing Geopy for 10km-radius precise asset discovery mapping. 

### `GET /api/hospitals`
* **Method:** `GET`
* **Query Parameters:** `?latitude=<float>&longitude=<float>`
* **Response format:**
  ```json
  {
    "status": "success",
    "data": [
      {
        "name": "City General Hospital",
        "latitude": 12.9716,
        "longitude": 77.5946,
        "distance_km": 1.25,
        "sector_id": "Indiranagar"
      }
    ]
  }
  ```

### `GET /api/fire_stations`
* **Method:** `GET`
* **Query Parameters:** `?latitude=<float>&longitude=<float>`
* **Response format:** (Same JSON format as Hospitals)

### `GET /api/police_stations`
* **Method:** `GET`
* **Query Parameters:** `?latitude=<float>&longitude=<float>`
* **Response format:** (Same JSON format as Hospitals)

### `GET /api/score`
A compiled analytical endpoint assessing the resilience capacity. Weighs existing emergency resources against each other to highlight the structural readiness and the weakest sector inside the 10km radius.
* **Weights:** Hospitals (3), Police (2), Fire (1).
* **Method:** `GET`
* **Query Parameters:** `?latitude=<float>&longitude=<float>`
* **Response format:**
  ```json
  {
    "status": "success",
    "data": {
      "location": {
        "latitude": 12.971598,
        "longitude": 77.594562
      },
      "total_score": 45,
      "facilities": {
        "hospitals": 8,
        "police_stations": 6,
        "fire_stations": 3
      },
      "weakest_sector": {
        "weakest_sector_id": "Koramangala",
        "weakest_sector_name": "Koramangala",
        "facility_count": 1,
        "facilities": [ ... ]
      },
      "facilities_list": [ ... ]
    }
  }
  ```
