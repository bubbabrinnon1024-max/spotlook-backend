import Foundation

final class FriendRequestService {
    private let baseURL = "https://spotlook-backend.onrender.com"

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    func sendRequest(fromCode: String, fromName: String, toCode: String) async throws -> FriendRequest {
        let payload = SendFriendRequestBody(
            fromCode: fromCode.trimmingCharacters(in: .whitespacesAndNewlines),
            fromName: fromName.trimmingCharacters(in: .whitespacesAndNewlines),
            toCode: toCode.trimmingCharacters(in: .whitespacesAndNewlines)
        )

        return try await postWithFallback(
            paths: [
                "/friend-request/send",
                "/friend-requests/send",
                "/friendRequests/send"
            ],
            body: payload,
            responseType: FriendRequest.self
        )
    }

    func loadIncomingRequests(for code: String) async throws -> [FriendRequest] {
        let cleanedCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
        let encodedCode = cleanedCode.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? cleanedCode
        return try await getWithFallback(
            paths: [
                "/friend-request/incoming?code=\(encodedCode)",
                "/friend-requests/incoming?code=\(encodedCode)",
                "/friendRequests/incoming?code=\(encodedCode)"
            ],
            responseType: [FriendRequest].self
        )
    }

    func loadOutgoingRequests(for code: String) async throws -> [FriendRequest] {
        let cleanedCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
        let encodedCode = cleanedCode.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? cleanedCode
        return try await getWithFallback(
            paths: [
                "/friend-request/outgoing?code=\(encodedCode)",
                "/friend-requests/outgoing?code=\(encodedCode)",
                "/friendRequests/outgoing?code=\(encodedCode)"
            ],
            responseType: [FriendRequest].self
        )
    }

    func acceptRequest(requestID: String) async throws -> FriendRequest {
        try await respond(to: requestID, action: "accepted")
    }

    func declineRequest(requestID: String) async throws -> FriendRequest {
        try await respond(to: requestID, action: "declined")
    }

    private func respond(to requestID: String, action: String) async throws -> FriendRequest {
        let payload = RespondFriendRequestBody(
            requestID: requestID,
            action: action
        )

        return try await postWithFallback(
            paths: [
                "/friend-request/respond",
                "/friend-requests/respond",
                "/friendRequests/respond"
            ],
            body: payload,
            responseType: FriendRequest.self
        )
    }

    private func get<Response: Decodable>(path: String, responseType: Response.Type) async throws -> Response {
        guard let url = URL(string: baseURL + path) else {
            throw FriendRequestServiceError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, data: data)
        return try decoder.decode(Response.self, from: data)
    }

    private func getWithFallback<Response: Decodable>(paths: [String], responseType: Response.Type) async throws -> Response {
        var lastError: Error?

        for path in paths {
            do {
                return try await get(path: path, responseType: responseType)
            } catch let error as FriendRequestServiceError {
                switch error {
                case .server(let message) where message.localizedCaseInsensitiveContains("Cannot GET") || message.localizedCaseInsensitiveContains("Cannot POST"):
                    lastError = error
                    continue
                default:
                    throw error
                }
            } catch {
                lastError = error
            }
        }

        throw lastError ?? FriendRequestServiceError.server("No matching friend request route was found.")
    }

    private func post<Body: Encodable, Response: Decodable>(path: String, body: Body, responseType: Response.Type) async throws -> Response {
        guard let url = URL(string: baseURL + path) else {
            throw FriendRequestServiceError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try encoder.encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, data: data)
        return try decoder.decode(Response.self, from: data)
    }

    private func postWithFallback<Body: Encodable, Response: Decodable>(paths: [String], body: Body, responseType: Response.Type) async throws -> Response {
        var lastError: Error?

        for path in paths {
            do {
                return try await post(path: path, body: body, responseType: responseType)
            } catch let error as FriendRequestServiceError {
                switch error {
                case .server(let message) where message.localizedCaseInsensitiveContains("Cannot GET") || message.localizedCaseInsensitiveContains("Cannot POST"):
                    lastError = error
                    continue
                default:
                    throw error
                }
            } catch {
                lastError = error
            }
        }

        throw lastError ?? FriendRequestServiceError.server("No matching friend request route was found.")
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw FriendRequestServiceError.invalidResponse
        }

        guard (200 ... 299).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "Unknown server error"
            throw FriendRequestServiceError.server(message)
        }
    }
}

private struct SendFriendRequestBody: Encodable {
    let fromCode: String
    let fromName: String
    let toCode: String
}

private struct RespondFriendRequestBody: Encodable {
    let requestID: String
    let action: String
}

enum FriendRequestServiceError: LocalizedError {
    case invalidURL
    case invalidResponse
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The friend request URL is invalid."
        case .invalidResponse:
            return "The server response was invalid."
        case .server(let message):
            return message
        }
    }
}
