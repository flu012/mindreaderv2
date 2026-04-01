using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace MindReader.Cloud.Tests.Tenants;

public class TenantIsolationTests : IClassFixture<CustomWebApplicationFactory>
{
    private readonly HttpClient _client;

    public TenantIsolationTests(CustomWebApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    private async Task<(string token, string tenantId)> RegisterAndLogin(string email)
    {
        var response = await _client.PostAsJsonAsync("/api/v1/auth/register", new
        {
            Email = email,
            Password = "TestPass123!",
            Name = email.Split('@')[0]
        });
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        return (
            json.GetProperty("token").GetString()!,
            json.GetProperty("user").GetProperty("tenantId").GetString()!
        );
    }

    [Fact]
    public async Task TwoUsers_GetDifferentTenantIds()
    {
        var (_, tenantA) = await RegisterAndLogin("tenantA@test.com");
        var (_, tenantB) = await RegisterAndLogin("tenantB@test.com");

        Assert.NotEqual(tenantA, tenantB);
    }

    [Fact]
    public async Task Me_ReturnsTenantId_InJwtClaims()
    {
        var (token, tenantId) = await RegisterAndLogin("claims@test.com");

        var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/auth/me");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(request);

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(tenantId, json.GetProperty("tenantId").GetString());
    }

    [Fact]
    public async Task Usage_RequiresAuth()
    {
        var response = await _client.GetAsync("/api/v1/usage");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }
}
