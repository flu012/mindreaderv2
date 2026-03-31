using System.Text;
using Microsoft.Extensions.Configuration;
using MindReader.Cloud.Application.Common.Interfaces;

namespace MindReader.Cloud.Infrastructure.Services;

public class GraphProxyService : IGraphProxyService
{
    private readonly HttpClient _httpClient;
    private readonly string _expressUrl;
    private readonly string _internalSecret;

    public GraphProxyService(HttpClient httpClient, IConfiguration config)
    {
        _httpClient = httpClient;
        _expressUrl = config["MindReader:ExpressUrl"] ?? "http://localhost:18900";
        _internalSecret = config["MindReader:InternalSecret"] ?? "";
    }

    public async Task<HttpResponseMessage> ForwardAsync(string path, HttpMethod method, string? body, string tenantId)
    {
        var url = $"{_expressUrl}{path}";
        var request = new HttpRequestMessage(method, url);

        // Inject tenant headers
        request.Headers.Add("X-Tenant-Id", tenantId);
        if (!string.IsNullOrEmpty(_internalSecret))
            request.Headers.Add("X-Internal-Secret", _internalSecret);

        if (body != null && (method == HttpMethod.Post || method == HttpMethod.Put || method == HttpMethod.Patch))
            request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        return await _httpClient.SendAsync(request);
    }
}
